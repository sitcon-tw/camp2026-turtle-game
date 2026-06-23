use axum::{
    Json, Router,
    extract::{Path, Query, State},
    routing::{get, post},
};
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;
use uuid::Uuid;

use crate::{
    auth::AdminUser,
    error::AppError,
    models::{Team, TeamId},
    state::{AppState, TeamUpdate},
};

use super::auth::{map_store_error, normalize_login_code};

const LOGIN_CODE_ALPHABET: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const LOGIN_CODE_LENGTH: usize = 6;
const LOGIN_CODE_ATTEMPTS: usize = 128;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/admin/teams", get(list_teams).post(create_team))
        .route("/admin/teams/bulk-create", post(bulk_create_teams))
        .route(
            "/admin/teams/{team_id}",
            get(get_team).patch(update_team).delete(delete_team),
        )
        .route("/admin/teams/{team_id}/rotate-code", post(rotate_code))
}

#[derive(Debug, Deserialize)]
struct ListTeamsQuery {
    enabled: Option<bool>,
    search: Option<String>,
}

async fn list_teams(
    AdminUser(_user): AdminUser,
    State(state): State<AppState>,
    Query(query): Query<ListTeamsQuery>,
) -> Result<Json<Vec<Team>>, AppError> {
    let search = query
        .search
        .as_deref()
        .map(str::trim)
        .filter(|search| !search.is_empty())
        .map(str::to_ascii_lowercase);
    let teams = state
        .repository
        .list_teams()
        .map_err(map_store_error)?
        .into_iter()
        .filter(|team| query.enabled.is_none_or(|enabled| team.enabled == enabled))
        .filter(|team| {
            search.as_deref().is_none_or(|search| {
                team.name.to_ascii_lowercase().contains(search)
                    || team.login_code.to_ascii_lowercase().contains(search)
                    || team
                        .note
                        .as_deref()
                        .is_some_and(|note| note.to_ascii_lowercase().contains(search))
            })
        })
        .collect();

    Ok(Json(teams))
}

#[derive(Debug, Clone, Deserialize)]
struct CreateTeamRequest {
    name: String,
    login_code: Option<String>,
    note: Option<String>,
}

async fn create_team(
    AdminUser(_user): AdminUser,
    State(state): State<AppState>,
    Json(request): Json<CreateTeamRequest>,
) -> Result<Json<Team>, AppError> {
    create_team_from_request(&state, request).map(Json)
}

#[derive(Debug, Deserialize)]
struct BulkCreateTeamsRequest {
    teams: Vec<CreateTeamRequest>,
}

#[derive(Debug, Serialize)]
struct BulkCreateTeamsResponse {
    teams: Vec<Team>,
}

async fn bulk_create_teams(
    AdminUser(_user): AdminUser,
    State(state): State<AppState>,
    Json(request): Json<BulkCreateTeamsRequest>,
) -> Result<Json<BulkCreateTeamsResponse>, AppError> {
    if request.teams.is_empty() {
        return Err(AppError::bad_request_code(
            "invalid_bulk_create",
            "teams must not be empty",
        ));
    }

    let mut teams = Vec::with_capacity(request.teams.len());
    for team_request in request.teams {
        teams.push(create_team_from_request(&state, team_request)?);
    }

    Ok(Json(BulkCreateTeamsResponse { teams }))
}

#[derive(Debug, Serialize)]
struct AdminTeamDetails {
    team: Team,
    challenge_statuses: Vec<Value>,
    recent_submissions: Vec<Value>,
    recent_score_events: Vec<Value>,
}

async fn get_team(
    AdminUser(_user): AdminUser,
    State(state): State<AppState>,
    Path(team_id): Path<Uuid>,
) -> Result<Json<AdminTeamDetails>, AppError> {
    let team = require_team(&state, TeamId::from(team_id))?;
    Ok(Json(AdminTeamDetails {
        team,
        challenge_statuses: Vec::new(),
        recent_submissions: Vec::new(),
        recent_score_events: Vec::new(),
    }))
}

#[derive(Debug, Default, Deserialize)]
struct UpdateTeamRequest {
    name: Option<String>,
    login_code: Option<String>,
    enabled: Option<bool>,
    #[serde(default, deserialize_with = "deserialize_optional_note")]
    note: Option<Option<String>>,
}

async fn update_team(
    AdminUser(_user): AdminUser,
    State(state): State<AppState>,
    Path(team_id): Path<Uuid>,
    Json(request): Json<UpdateTeamRequest>,
) -> Result<Json<Team>, AppError> {
    let update = TeamUpdate {
        name: request.name.map(validate_team_name).transpose()?,
        login_code: request
            .login_code
            .map(|code| normalize_login_code(&code))
            .transpose()?,
        enabled: request.enabled,
        note: request.note.map(normalize_note),
    };

    let team = state
        .repository
        .update_team(TeamId::from(team_id), update)
        .map_err(map_store_error)?;
    Ok(Json(team))
}

#[derive(Debug, Serialize)]
struct DeleteTeamResponse {
    disabled: bool,
    team: Team,
}

async fn delete_team(
    AdminUser(_user): AdminUser,
    State(state): State<AppState>,
    Path(team_id): Path<Uuid>,
) -> Result<Json<DeleteTeamResponse>, AppError> {
    let team = state
        .repository
        .set_team_enabled(TeamId::from(team_id), false)
        .map_err(map_store_error)?;
    Ok(Json(DeleteTeamResponse {
        disabled: true,
        team,
    }))
}

#[derive(Debug, Serialize)]
struct RotateCodeResponse {
    team: Team,
    login_code: String,
}

async fn rotate_code(
    AdminUser(_user): AdminUser,
    State(state): State<AppState>,
    Path(team_id): Path<Uuid>,
) -> Result<Json<RotateCodeResponse>, AppError> {
    let login_code = generate_unique_login_code(&state)?;
    let team = state
        .repository
        .update_team(
            TeamId::from(team_id),
            TeamUpdate {
                login_code: Some(login_code.clone()),
                ..TeamUpdate::default()
            },
        )
        .map_err(map_store_error)?;
    Ok(Json(RotateCodeResponse { team, login_code }))
}

fn create_team_from_request(
    state: &AppState,
    request: CreateTeamRequest,
) -> Result<Team, AppError> {
    let name = validate_team_name(request.name)?;
    let login_code = match request.login_code {
        Some(login_code) => normalize_login_code(&login_code)?,
        None => generate_unique_login_code(state)?,
    };

    state
        .repository
        .create_team(name, login_code, normalize_note(request.note))
        .map_err(map_store_error)
}

fn require_team(state: &AppState, team_id: TeamId) -> Result<Team, AppError> {
    state
        .repository
        .get_team(team_id)
        .map_err(map_store_error)?
        .ok_or_else(|| AppError::not_found_code("team_not_found", "team was not found"))
}

fn validate_team_name(name: String) -> Result<String, AppError> {
    let name = name.trim().to_owned();
    if name.is_empty() {
        return Err(AppError::bad_request_code(
            "invalid_team_name",
            "team name must not be empty",
        ));
    }

    Ok(name)
}

fn normalize_note(note: Option<String>) -> Option<String> {
    note.and_then(|note| {
        let note = note.trim().to_owned();
        if note.is_empty() { None } else { Some(note) }
    })
}

fn deserialize_optional_note<'de, D>(deserializer: D) -> Result<Option<Option<String>>, D::Error>
where
    D: Deserializer<'de>,
{
    Option::<String>::deserialize(deserializer).map(Some)
}

fn generate_unique_login_code(state: &AppState) -> Result<String, AppError> {
    for _ in 0..LOGIN_CODE_ATTEMPTS {
        let login_code = generate_login_code();
        match state.repository.team_by_login_code(&login_code) {
            Ok(None) => return Ok(login_code),
            Ok(Some(_)) => {}
            Err(error) => return Err(map_store_error(error)),
        }
    }

    Err(AppError::internal(
        "failed to generate a unique team login code",
    ))
}

fn generate_login_code() -> String {
    let uuid = Uuid::new_v4();
    let bytes = uuid.as_bytes();
    let mut login_code = String::with_capacity(LOGIN_CODE_LENGTH);
    for byte in bytes.iter().take(LOGIN_CODE_LENGTH) {
        let index = usize::from(*byte) % LOGIN_CODE_ALPHABET.len();
        login_code.push(char::from(LOGIN_CODE_ALPHABET[index]));
    }
    login_code
}
