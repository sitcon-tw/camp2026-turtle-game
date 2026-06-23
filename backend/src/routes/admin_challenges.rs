use axum::{
    Json, Router,
    body::Body,
    extract::{Multipart, Path, Query, State},
    http::{StatusCode, header},
    response::{IntoResponse, Response},
    routing::{delete, get, patch, post},
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use uuid::Uuid;

use crate::{
    auth::AdminUser,
    challenge_set_zip::{
        ChallengeSetZipError, ExportImage, imported_asset_id, read_import_zip, write_export_zip,
    },
    error::AppError,
    models::{Challenge, ChallengeId, ChallengeSet, ChallengeSetId, ChallengeSetStatus},
    state::{
        AppState, ChallengeReorder, ChallengeStats, ChallengeTargetImageUpdate, ChallengeUpdate,
        NewChallenge, StoreError,
    },
};

pub fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/admin/challenge-sets",
            get(list_challenge_sets).post(create_challenge_set),
        )
        .route("/admin/challenge-sets/import", post(import_challenge_set))
        .route("/admin/challenge-sets/{set_id}", get(get_challenge_set))
        .route(
            "/admin/challenge-sets/{set_id}/challenges",
            post(create_challenge),
        )
        .route(
            "/admin/challenge-sets/{set_id}/activate",
            post(activate_challenge_set),
        )
        .route(
            "/admin/challenge-sets/{set_id}/archive",
            post(archive_challenge_set),
        )
        .route(
            "/admin/challenge-sets/{set_id}/export",
            get(export_challenge_set),
        )
        .route("/admin/challenges", get(list_challenges))
        .route("/admin/challenges/{challenge_id}", get(get_challenge))
        .route("/admin/challenges/{challenge_id}", patch(update_challenge))
        .route("/admin/challenges/{challenge_id}", delete(delete_challenge))
        .route(
            "/admin/challenges/{challenge_id}/target-image",
            post(upload_challenge_target_image),
        )
        .route("/admin/challenges/reorder", post(reorder_challenges))
}

async fn list_challenge_sets(
    AdminUser(_user): AdminUser,
    State(state): State<AppState>,
) -> Result<Json<Vec<ChallengeSetResponse>>, AppError> {
    let challenge_sets = state
        .repository
        .list_challenge_sets()
        .map_err(store_error)?;
    let mut response = Vec::with_capacity(challenge_sets.len());
    for challenge_set in challenge_sets {
        let challenge_count = state
            .repository
            .list_challenges(challenge_set.id)
            .map_err(store_error)?
            .len();
        response.push(ChallengeSetResponse {
            challenge_set,
            challenge_count,
        });
    }
    Ok(Json(response))
}

async fn create_challenge_set(
    AdminUser(_user): AdminUser,
    State(state): State<AppState>,
    Json(payload): Json<CreateChallengeSetRequest>,
) -> Result<(StatusCode, Json<ChallengeSetResponse>), AppError> {
    let name = non_empty_trimmed(payload.name, "name")?;
    let version = non_empty_trimmed(payload.version, "version")?;
    let challenge_set = state
        .repository
        .create_challenge_set(&name, &version, ChallengeSetStatus::Draft)
        .map_err(store_error)?;
    Ok((
        StatusCode::CREATED,
        Json(ChallengeSetResponse {
            challenge_set,
            challenge_count: 0,
        }),
    ))
}

async fn import_challenge_set(
    AdminUser(_user): AdminUser,
    State(state): State<AppState>,
    mut multipart: Multipart,
) -> Result<(StatusCode, Json<ChallengeSetResponse>), AppError> {
    let zip_bytes = multipart_file_bytes(&mut multipart).await?;
    let imported = read_import_zip(&zip_bytes).map_err(zip_error)?;
    let challenge_set = state
        .repository
        .create_challenge_set(
            &imported.manifest.name,
            &imported.manifest.version,
            ChallengeSetStatus::Draft,
        )
        .map_err(store_error)?;
    let challenge_count = imported.manifest.challenges.len();

    for manifest_challenge in imported.manifest.challenges {
        let image = imported
            .images
            .get(&manifest_challenge.target_image_path)
            .ok_or_else(|| AppError::bad_request("challenge image is missing"))?;
        let asset_id = imported_asset_id();
        state
            .asset_storage
            .put_asset(&asset_id, image.content_type, image.bytes.clone())
            .map_err(store_error)?;
        state
            .repository
            .create_challenge(NewChallenge {
                challenge_set_id: challenge_set.id,
                slug: manifest_challenge.slug,
                title: manifest_challenge.title,
                description: manifest_challenge.description,
                target_image_asset_id: Some(asset_id),
                target_image_path: Some(manifest_challenge.target_image_path),
                target_image_url: None,
                points: manifest_challenge.points,
                pass_threshold: manifest_challenge.pass_threshold,
                enabled: manifest_challenge.enabled,
                order: manifest_challenge.order,
                canvas: manifest_challenge.canvas,
                judge_config: manifest_challenge.judge_config,
            })
            .map_err(store_error)?;
    }

    Ok((
        StatusCode::CREATED,
        Json(ChallengeSetResponse {
            challenge_set,
            challenge_count,
        }),
    ))
}

async fn get_challenge_set(
    AdminUser(_user): AdminUser,
    State(state): State<AppState>,
    Path(set_id): Path<Uuid>,
) -> Result<Json<ChallengeSetDetailResponse>, AppError> {
    let set_id = ChallengeSetId::from(set_id);
    let challenge_set = state
        .repository
        .get_challenge_set(set_id)
        .map_err(store_error)?
        .ok_or_else(|| AppError::not_found("challenge set not found"))?;
    let challenges = state
        .repository
        .list_challenges(set_id)
        .map_err(store_error)?;
    Ok(Json(ChallengeSetDetailResponse {
        challenge_set,
        challenges,
    }))
}

async fn create_challenge(
    AdminUser(_user): AdminUser,
    State(state): State<AppState>,
    Path(set_id): Path<Uuid>,
    Json(payload): Json<CreateChallengeRequest>,
) -> Result<(StatusCode, Json<AdminChallengeResponse>), AppError> {
    let challenge = state
        .repository
        .create_challenge(payload.into_new_challenge(ChallengeSetId::from(set_id))?)
        .map_err(store_error)?;
    let response = admin_challenge_response(&state, challenge.id)?;
    Ok((StatusCode::CREATED, Json(response)))
}

async fn activate_challenge_set(
    AdminUser(_user): AdminUser,
    State(state): State<AppState>,
    Path(set_id): Path<Uuid>,
) -> Result<Json<ChallengeSet>, AppError> {
    let challenge_set = state
        .repository
        .activate_challenge_set(ChallengeSetId::from(set_id))
        .map_err(store_error)?;
    Ok(Json(challenge_set))
}

async fn archive_challenge_set(
    AdminUser(_user): AdminUser,
    State(state): State<AppState>,
    Path(set_id): Path<Uuid>,
) -> Result<Json<ChallengeSet>, AppError> {
    let challenge_set = state
        .repository
        .archive_challenge_set(ChallengeSetId::from(set_id))
        .map_err(store_error)?;
    Ok(Json(challenge_set))
}

async fn export_challenge_set(
    AdminUser(_user): AdminUser,
    State(state): State<AppState>,
    Path(set_id): Path<Uuid>,
) -> Result<Response, AppError> {
    let set_id = ChallengeSetId::from(set_id);
    let challenge_set = state
        .repository
        .get_challenge_set(set_id)
        .map_err(store_error)?
        .ok_or_else(|| AppError::not_found("challenge set not found"))?;
    let challenges = state
        .repository
        .list_challenges(set_id)
        .map_err(store_error)?;
    let mut images = Vec::new();
    for challenge in &challenges {
        let Some(asset_id) = challenge.target_image_asset_id.as_deref() else {
            continue;
        };
        let Some(asset) = state
            .asset_storage
            .get_asset(asset_id)
            .map_err(store_error)?
        else {
            continue;
        };
        images.push(ExportImage {
            path: challenge
                .target_image_path
                .clone()
                .unwrap_or_else(|| format!("images/{}.png", challenge.slug)),
            bytes: asset.bytes,
        });
    }
    let zip_bytes = write_export_zip(&challenge_set, &challenges, &images).map_err(zip_error)?;
    let file_name = format!("challenge-set-{}.zip", challenge_set.id.as_uuid());
    let response = (
        [
            (header::CONTENT_TYPE, "application/zip".to_owned()),
            (
                header::CONTENT_DISPOSITION,
                format!("attachment; filename=\"{file_name}\""),
            ),
        ],
        Body::from(zip_bytes),
    )
        .into_response();
    Ok(response)
}

async fn list_challenges(
    AdminUser(_user): AdminUser,
    State(state): State<AppState>,
    Query(filters): Query<ChallengeFilters>,
) -> Result<Json<Vec<Challenge>>, AppError> {
    let mut challenges = if let Some(set_id) = filters.challenge_set_id {
        state
            .repository
            .list_challenges(ChallengeSetId::from(set_id))
            .map_err(store_error)?
    } else {
        state
            .repository
            .list_all_challenges()
            .map_err(store_error)?
    };
    if filters.active_only.unwrap_or(false) {
        let active_set_id = state
            .repository
            .active_challenge_set()
            .map_err(store_error)?
            .map(|challenge_set| challenge_set.id);
        challenges.retain(|challenge| Some(challenge.challenge_set_id) == active_set_id);
    }
    Ok(Json(challenges))
}

async fn get_challenge(
    AdminUser(_user): AdminUser,
    State(state): State<AppState>,
    Path(challenge_id): Path<Uuid>,
) -> Result<Json<AdminChallengeResponse>, AppError> {
    admin_challenge_response(&state, ChallengeId::from(challenge_id)).map(Json)
}

async fn update_challenge(
    AdminUser(_user): AdminUser,
    State(state): State<AppState>,
    Path(challenge_id): Path<Uuid>,
    Json(payload): Json<ChallengePatchRequest>,
) -> Result<Json<AdminChallengeResponse>, AppError> {
    payload.validate()?;
    state
        .repository
        .update_challenge(ChallengeId::from(challenge_id), payload.into_update())
        .map_err(store_error)?;
    admin_challenge_response(&state, ChallengeId::from(challenge_id)).map(Json)
}

async fn upload_challenge_target_image(
    AdminUser(_user): AdminUser,
    State(state): State<AppState>,
    Path(challenge_id): Path<Uuid>,
    mut multipart: Multipart,
) -> Result<Json<AdminChallengeResponse>, AppError> {
    let challenge_id = ChallengeId::from(challenge_id);
    let challenge = state
        .repository
        .get_challenge(challenge_id)
        .map_err(store_error)?
        .ok_or_else(|| AppError::not_found("challenge not found"))?;
    let upload = multipart_image_upload(&mut multipart, &challenge.slug).await?;
    let asset_id = imported_asset_id();
    state
        .asset_storage
        .put_asset(&asset_id, upload.content_type, upload.bytes)
        .map_err(store_error)?;
    state
        .repository
        .update_challenge_target_image(
            challenge_id,
            ChallengeTargetImageUpdate {
                target_image_asset_id: asset_id,
                target_image_path: upload.path,
                target_image_url: None,
            },
        )
        .map_err(store_error)?;
    admin_challenge_response(&state, challenge_id).map(Json)
}

async fn delete_challenge(
    AdminUser(_user): AdminUser,
    State(state): State<AppState>,
    Path(challenge_id): Path<Uuid>,
) -> Result<Json<AdminChallengeResponse>, AppError> {
    let challenge_id = ChallengeId::from(challenge_id);
    state
        .repository
        .disable_challenge(challenge_id)
        .map_err(store_error)?;
    admin_challenge_response(&state, challenge_id).map(Json)
}

async fn reorder_challenges(
    AdminUser(_user): AdminUser,
    State(state): State<AppState>,
    Json(payload): Json<ReorderRequest>,
) -> Result<Json<Vec<Challenge>>, AppError> {
    if payload.items.is_empty() {
        return Err(AppError::bad_request("reorder items are required"));
    }
    let reorders: Vec<_> = payload
        .items
        .into_iter()
        .map(|item| ChallengeReorder {
            challenge_id: ChallengeId::from(item.challenge_id),
            order: item.order,
        })
        .collect();
    let challenges = state
        .repository
        .reorder_challenges(&reorders)
        .map_err(store_error)?;
    Ok(Json(challenges))
}

#[derive(Debug, Serialize)]
struct ChallengeSetResponse {
    #[serde(flatten)]
    challenge_set: ChallengeSet,
    challenge_count: usize,
}

#[derive(Debug, Deserialize)]
struct CreateChallengeSetRequest {
    name: String,
    version: String,
}

#[derive(Debug, Serialize)]
struct ChallengeSetDetailResponse {
    #[serde(flatten)]
    challenge_set: ChallengeSet,
    challenges: Vec<Challenge>,
}

#[derive(Debug, Deserialize)]
struct ChallengeFilters {
    challenge_set_id: Option<Uuid>,
    active_only: Option<bool>,
}

#[derive(Debug, Serialize)]
struct AdminChallengeResponse {
    #[serde(flatten)]
    challenge: Challenge,
    stats: ChallengeStatsResponse,
}

#[derive(Debug, Serialize)]
struct ChallengeStatsResponse {
    submission_count: usize,
    solved_count: usize,
    best_similarity: Option<f64>,
}

impl From<ChallengeStats> for ChallengeStatsResponse {
    fn from(stats: ChallengeStats) -> Self {
        Self {
            submission_count: stats.submission_count,
            solved_count: stats.solved_count,
            best_similarity: stats.best_similarity,
        }
    }
}

#[derive(Debug, Deserialize)]
struct CreateChallengeRequest {
    slug: String,
    title: String,
    #[serde(default)]
    description: String,
    points: i32,
    pass_threshold: f64,
    #[serde(default = "default_enabled")]
    enabled: bool,
    #[serde(default)]
    order: i32,
    #[serde(default)]
    canvas: crate::models::CanvasConfig,
    #[serde(default = "default_judge_config")]
    judge_config: serde_json::Value,
}

impl CreateChallengeRequest {
    fn into_new_challenge(
        self,
        challenge_set_id: ChallengeSetId,
    ) -> Result<NewChallenge, AppError> {
        let slug = non_empty_trimmed(self.slug, "slug")?;
        let title = non_empty_trimmed(self.title, "title")?;
        validate_points(self.points)?;
        validate_pass_threshold(self.pass_threshold)?;
        Ok(NewChallenge {
            challenge_set_id,
            slug,
            title,
            description: self.description,
            target_image_asset_id: None,
            target_image_path: None,
            target_image_url: None,
            points: self.points,
            pass_threshold: self.pass_threshold,
            enabled: self.enabled,
            order: self.order,
            canvas: self.canvas,
            judge_config: self.judge_config,
        })
    }
}

#[derive(Debug, Deserialize)]
struct ChallengePatchRequest {
    title: Option<String>,
    description: Option<String>,
    points: Option<i32>,
    pass_threshold: Option<f64>,
    enabled: Option<bool>,
    order: Option<i32>,
}

impl ChallengePatchRequest {
    fn validate(&self) -> Result<(), AppError> {
        if self
            .title
            .as_deref()
            .is_some_and(|title| title.trim().is_empty())
        {
            return Err(AppError::bad_request("title cannot be empty"));
        }
        if self
            .pass_threshold
            .is_some_and(|threshold| !threshold.is_finite())
        {
            return Err(AppError::bad_request("pass_threshold must be finite"));
        }
        if self.points.is_some_and(|points| points < 0) {
            return Err(AppError::bad_request("points must not be negative"));
        }
        Ok(())
    }

    fn into_update(self) -> ChallengeUpdate {
        ChallengeUpdate {
            title: self.title,
            description: self.description,
            points: self.points,
            pass_threshold: self.pass_threshold,
            enabled: self.enabled,
            order: self.order,
        }
    }
}

#[derive(Debug, Deserialize)]
struct ReorderRequest {
    items: Vec<ReorderItem>,
}

#[derive(Debug, Deserialize)]
struct ReorderItem {
    challenge_id: Uuid,
    order: i32,
}

async fn multipart_file_bytes(multipart: &mut Multipart) -> Result<Vec<u8>, AppError> {
    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|_| AppError::bad_request("multipart body is invalid"))?
    {
        if field.name() != Some("file") {
            continue;
        }
        let bytes = field
            .bytes()
            .await
            .map_err(|_| AppError::bad_request("multipart file is invalid"))?;
        return Ok(bytes.to_vec());
    }
    Err(AppError::bad_request("multipart field file is required"))
}

#[derive(Debug)]
struct ImageUpload {
    path: String,
    content_type: &'static str,
    bytes: Vec<u8>,
}

async fn multipart_image_upload(
    multipart: &mut Multipart,
    challenge_slug: &str,
) -> Result<ImageUpload, AppError> {
    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|_| AppError::bad_request("multipart body is invalid"))?
    {
        if field.name() != Some("file") {
            continue;
        }
        let file_name = field.file_name().map(str::to_owned);
        let bytes = field
            .bytes()
            .await
            .map_err(|_| AppError::bad_request("multipart file is invalid"))?
            .to_vec();
        let content_type = image_content_type(&bytes)
            .ok_or_else(|| AppError::bad_request("target image must be png or jpeg"))?;
        validate_image_bytes(&bytes)?;
        let path = image_path_for_upload(challenge_slug, file_name.as_deref(), content_type)?;
        return Ok(ImageUpload {
            path,
            content_type,
            bytes,
        });
    }
    Err(AppError::bad_request("multipart field file is required"))
}

fn image_content_type(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Some("image/png");
    }
    if bytes.starts_with(&[0xff, 0xd8]) {
        return Some("image/jpeg");
    }
    None
}

fn validate_image_bytes(bytes: &[u8]) -> Result<(), AppError> {
    image::load_from_memory(bytes)
        .map(|_| ())
        .map_err(|_| AppError::bad_request("target image is invalid"))
}

fn image_path_for_upload(
    challenge_slug: &str,
    file_name: Option<&str>,
    content_type: &str,
) -> Result<String, AppError> {
    let extension = match content_type {
        "image/png" => "png",
        "image/jpeg" => "jpg",
        _ => return Err(AppError::bad_request("target image must be png or jpeg")),
    };
    let Some(file_name) = file_name
        .map(str::trim)
        .filter(|file_name| !file_name.is_empty())
    else {
        return Ok(format!("images/{challenge_slug}.{extension}"));
    };
    if file_name.contains('/') || file_name.contains('\\') || file_name == "." || file_name == ".."
    {
        return Err(AppError::bad_request("target image filename is invalid"));
    }
    Ok(format!("images/{file_name}"))
}

fn non_empty_trimmed(value: String, field_name: &str) -> Result<String, AppError> {
    let value = value.trim().to_owned();
    if value.is_empty() {
        return Err(AppError::bad_request(format!(
            "{field_name} must not be empty"
        )));
    }
    Ok(value)
}

fn validate_points(points: i32) -> Result<(), AppError> {
    if points < 0 {
        return Err(AppError::bad_request("points must not be negative"));
    }
    Ok(())
}

fn validate_pass_threshold(pass_threshold: f64) -> Result<(), AppError> {
    if !pass_threshold.is_finite() {
        return Err(AppError::bad_request("pass_threshold must be finite"));
    }
    Ok(())
}

fn default_enabled() -> bool {
    true
}

fn default_judge_config() -> serde_json::Value {
    json!({})
}

fn admin_challenge_response(
    state: &AppState,
    challenge_id: ChallengeId,
) -> Result<AdminChallengeResponse, AppError> {
    let challenge = state
        .repository
        .get_challenge(challenge_id)
        .map_err(store_error)?
        .ok_or_else(|| AppError::not_found("challenge not found"))?;
    let stats = state
        .repository
        .challenge_stats(challenge_id)
        .map_err(store_error)?;
    Ok(AdminChallengeResponse {
        challenge,
        stats: stats.into(),
    })
}

fn store_error(error: StoreError) -> AppError {
    match error {
        StoreError::NotFound { entity } => AppError::not_found(format!("{entity} not found")),
        StoreError::DuplicateLoginCode
        | StoreError::DuplicateChallengeSlug
        | StoreError::DuplicateChallengePass
        | StoreError::SubmissionNotQueued
        | StoreError::ScoreOverflow
        | StoreError::AdminSetRequiresScore
        | StoreError::ChallengePassRequiresChallenge => AppError::bad_request(error.to_string()),
        StoreError::CannotArchiveOnlyActive => {
            AppError::conflict_code("active_challenge_set_required", error.to_string())
        }
        StoreError::LockUnavailable => AppError::internal("store is unavailable"),
    }
}

fn zip_error(error: ChallengeSetZipError) -> AppError {
    AppError::bad_request(error.to_string()).with_details(json!({
        "type": format!("{error:?}"),
    }))
}
