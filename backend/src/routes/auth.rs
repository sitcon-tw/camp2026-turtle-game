use std::time::Duration;

use axum::{
    Json, Router,
    extract::State,
    routing::{get, post},
};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{
    auth::{AdminUser, TeamUser, issue_token},
    error::AppError,
    models::{Role, Team, TeamId, Timestamp},
    state::{AppState, StoreError},
};

const ADMIN_SUBJECT: &str = "admin";
const DEFAULT_ADMIN_PASSWORD: &str = "admin-password";

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/team/login", post(team_login))
        .route("/me", get(team_me))
        .route("/admin/login", post(admin_login))
        .route("/admin/me", get(admin_me))
}

#[derive(Debug, Deserialize)]
struct TeamLoginRequest {
    code: String,
}

#[derive(Debug, Serialize)]
struct TeamLoginResponse {
    team: PublicTeam,
    access_token: String,
    role: Role,
    subject: String,
}

async fn team_login(
    State(state): State<AppState>,
    Json(request): Json<TeamLoginRequest>,
) -> Result<Json<TeamLoginResponse>, AppError> {
    let login_code = normalize_login_code(&request.code)?;
    let Some(team) = state
        .repository
        .team_by_login_code(&login_code)
        .map_err(map_store_error)?
    else {
        return Err(AppError::unauthorized_code(
            "invalid_team_code",
            "team login code is invalid",
        ));
    };

    if !team.enabled {
        return Err(AppError::forbidden_code(
            "team_disabled",
            "team is disabled",
        ));
    }

    let subject = team.id.as_uuid().to_string();
    let access_token = issue_access_token(&state, subject.clone(), Role::Team)?;
    Ok(Json(TeamLoginResponse {
        team: PublicTeam::from(team),
        access_token,
        role: Role::Team,
        subject,
    }))
}

async fn team_me(
    State(state): State<AppState>,
    TeamUser(user): TeamUser,
) -> Result<Json<PublicTeam>, AppError> {
    let team_id = parse_team_subject(&user.subject)?;
    let team = state
        .repository
        .get_team(team_id)
        .map_err(map_store_error)?
        .ok_or_else(|| AppError::not_found_code("team_not_found", "team was not found"))?;

    if !team.enabled {
        return Err(AppError::forbidden_code(
            "team_disabled",
            "team is disabled",
        ));
    }

    Ok(Json(PublicTeam::from(team)))
}

#[derive(Debug, Deserialize)]
struct AdminLoginRequest {
    password: String,
}

#[derive(Debug, Serialize)]
struct AdminLoginResponse {
    access_token: String,
    role: Role,
    subject: &'static str,
}

async fn admin_login(
    State(state): State<AppState>,
    Json(request): Json<AdminLoginRequest>,
) -> Result<Json<AdminLoginResponse>, AppError> {
    if request.password != admin_password() {
        return Err(AppError::unauthorized_code(
            "invalid_admin_password",
            "admin password is invalid",
        ));
    }

    let access_token = issue_access_token(&state, ADMIN_SUBJECT, Role::Admin)?;
    Ok(Json(AdminLoginResponse {
        access_token,
        role: Role::Admin,
        subject: ADMIN_SUBJECT,
    }))
}

#[derive(Debug, Serialize)]
struct AdminMeResponse {
    role: Role,
    subject: String,
}

async fn admin_me(AdminUser(user): AdminUser) -> Json<AdminMeResponse> {
    Json(AdminMeResponse {
        role: Role::Admin,
        subject: user.subject,
    })
}

#[derive(Debug, Clone, Serialize)]
pub struct PublicTeam {
    pub id: TeamId,
    pub name: String,
    pub enabled: bool,
    pub note: Option<String>,
    pub total_score: i32,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
}

impl From<Team> for PublicTeam {
    fn from(team: Team) -> Self {
        Self {
            id: team.id,
            name: team.name,
            enabled: team.enabled,
            note: team.note,
            total_score: team.total_score,
            created_at: team.created_at,
            updated_at: team.updated_at,
        }
    }
}

fn issue_access_token(
    state: &AppState,
    subject: impl Into<String>,
    role: Role,
) -> Result<String, AppError> {
    issue_token(
        subject,
        role,
        Duration::from_secs(state.config.token_ttl.as_secs()),
        &state.auth_secret,
    )
    .map_err(AppError::from)
}

fn parse_team_subject(subject: &str) -> Result<TeamId, AppError> {
    subject
        .parse::<Uuid>()
        .map(TeamId::from)
        .map_err(|_| AppError::unauthorized_code("invalid_team_token", "team token is invalid"))
}

pub(super) fn normalize_login_code(login_code: &str) -> Result<String, AppError> {
    let login_code = login_code.trim().to_ascii_uppercase();
    if login_code.is_empty() {
        return Err(AppError::bad_request_code(
            "invalid_login_code",
            "login code must not be empty",
        ));
    }

    Ok(login_code)
}

pub(super) fn map_store_error(error: StoreError) -> AppError {
    match error {
        StoreError::DuplicateLoginCode => {
            AppError::conflict_code("duplicate_login_code", "team login code already exists")
        }
        StoreError::NotFound { entity: "team" } => {
            AppError::not_found_code("team_not_found", "team was not found")
        }
        StoreError::LockUnavailable => AppError::internal("store lock is unavailable"),
        StoreError::DuplicateChallengeSlug
        | StoreError::DuplicateChallengePass
        | StoreError::NotFound { .. }
        | StoreError::SubmissionNotQueued
        | StoreError::ScoreOverflow
        | StoreError::AdminSetRequiresScore
        | StoreError::ChallengePassRequiresChallenge
        | StoreError::CannotArchiveOnlyActive => AppError::internal("store operation failed"),
    }
}

fn admin_password() -> String {
    std::env::var("ADMIN_PASSWORD")
        .ok()
        .filter(|password| !password.is_empty())
        .unwrap_or_else(|| DEFAULT_ADMIN_PASSWORD.to_owned())
}
