use axum::{
    Json, Router,
    extract::{Path, State},
    routing::get,
};
use serde::Serialize;
use uuid::Uuid;

use crate::{
    auth::TeamUser,
    error::AppError,
    models::{Challenge, ChallengeId, ChallengeProgressStatus, ChallengeSetStatus, TeamId},
    state::{AppState, StoreError, TeamChallengeProgress},
};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/challenges", get(list_challenges))
        .route("/challenges/{challenge_id}", get(get_challenge))
}

async fn list_challenges(
    State(state): State<AppState>,
    TeamUser(user): TeamUser,
) -> Result<Json<Vec<TeamChallengeResponse>>, AppError> {
    let team_id = require_team(&state, &user)?;
    let Some(active_set) = state
        .repository
        .active_challenge_set()
        .map_err(store_error)?
    else {
        return Ok(Json(Vec::new()));
    };
    let challenges = state
        .repository
        .list_challenges(active_set.id)
        .map_err(store_error)?;
    let mut response = Vec::new();
    for challenge in challenges.into_iter().filter(|challenge| challenge.enabled) {
        let progress = state
            .repository
            .team_challenge_progress(team_id, challenge.id)
            .map_err(store_error)?;
        response.push(TeamChallengeResponse::new(challenge, progress));
    }

    Ok(Json(response))
}

async fn get_challenge(
    State(state): State<AppState>,
    TeamUser(user): TeamUser,
    Path(challenge_id): Path<Uuid>,
) -> Result<Json<TeamChallengeResponse>, AppError> {
    let team_id = require_team(&state, &user)?;
    let challenge_id = ChallengeId::from(challenge_id);
    let challenge = state
        .repository
        .get_challenge(challenge_id)
        .map_err(store_error)?
        .ok_or_else(|| AppError::not_found("challenge not found"))?;
    let challenge_set = state
        .repository
        .get_challenge_set(challenge.challenge_set_id)
        .map_err(store_error)?
        .ok_or_else(|| AppError::not_found("challenge set not found"))?;
    if challenge_set.status != ChallengeSetStatus::Active || !challenge.enabled {
        return Err(AppError::not_found("challenge not found"));
    }

    let progress = state
        .repository
        .team_challenge_progress(team_id, challenge.id)
        .map_err(store_error)?;
    Ok(Json(TeamChallengeResponse::new(challenge, progress)))
}

#[derive(Debug, Serialize)]
struct TeamChallengeResponse {
    #[serde(flatten)]
    challenge: Challenge,
    status: ChallengeProgressStatus,
    submission_count: usize,
}

impl TeamChallengeResponse {
    fn new(challenge: Challenge, progress: TeamChallengeProgress) -> Self {
        Self {
            challenge,
            status: progress.status,
            submission_count: progress.submission_count,
        }
    }
}

fn require_team(
    state: &AppState,
    user: &crate::auth::AuthenticatedUser,
) -> Result<TeamId, AppError> {
    let team_uuid = Uuid::parse_str(&user.subject)
        .map_err(|_| AppError::unauthorized("token subject is invalid"))?;
    let team_id = TeamId::from(team_uuid);
    let team = state
        .repository
        .get_team(team_id)
        .map_err(store_error)?
        .ok_or_else(|| AppError::unauthorized("team is invalid"))?;
    if !team.enabled {
        return Err(AppError::forbidden("team is disabled"));
    }
    Ok(team_id)
}

fn store_error(error: StoreError) -> AppError {
    match error {
        StoreError::NotFound { entity } => AppError::not_found(format!("{entity} not found")),
        StoreError::DuplicateLoginCode
        | StoreError::DuplicateChallengeSlug
        | StoreError::DuplicateChallengePass
        | StoreError::InvalidatedStreamSession
        | StoreError::SubmissionNotQueued
        | StoreError::ScoreOverflow
        | StoreError::AdminSetRequiresScore
        | StoreError::ChallengePassRequiresChallenge
        | StoreError::CannotArchiveOnlyActive => AppError::bad_request(error.to_string()),
        StoreError::LockUnavailable => AppError::internal("store is unavailable"),
    }
}
