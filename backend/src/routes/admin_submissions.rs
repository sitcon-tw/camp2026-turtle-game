use axum::{
    Json, Router,
    extract::{Path, Query, State},
    routing::{get, post},
};
use serde::Serialize;

use crate::{
    auth::AuthenticatedUser,
    error::AppError,
    models::{Role, Submission, SubmissionId},
    routes::submissions::judge_and_store_submission,
    state::{AppState, SubmissionListFilter},
};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/admin/submissions", get(list_submissions))
        .route("/admin/submissions/{submission_id}", get(get_submission))
        .route(
            "/admin/submissions/{submission_id}/retry",
            post(retry_submission),
        )
}

async fn list_submissions(
    State(state): State<AppState>,
    user: AuthenticatedUser,
    Query(filter): Query<SubmissionListFilter>,
) -> Result<Json<Vec<Submission>>, AppError> {
    require_admin(&user)?;
    Ok(Json(state.repository.list_submissions(filter)?))
}

async fn get_submission(
    State(state): State<AppState>,
    user: AuthenticatedUser,
    Path(submission_id): Path<SubmissionId>,
) -> Result<Json<Submission>, AppError> {
    require_admin(&user)?;
    let submission = state
        .repository
        .get_submission(submission_id)?
        .ok_or_else(|| AppError::not_found("submission was not found"))?;
    Ok(Json(submission))
}

async fn retry_submission(
    State(state): State<AppState>,
    user: AuthenticatedUser,
    Path(submission_id): Path<SubmissionId>,
) -> Result<Json<RetryResponse>, AppError> {
    require_admin(&user)?;
    let original = state
        .repository
        .get_submission(submission_id)?
        .ok_or_else(|| AppError::not_found("submission was not found"))?;
    let retry = state.repository.create_submission(
        original.team_id,
        original.challenge_id,
        original.block_program,
        Some(original.id),
    )?;
    let retry = judge_and_store_submission(&state, retry).await?;
    Ok(Json(RetryResponse {
        submission: retry,
    }))
}

#[derive(Debug, Serialize)]
struct RetryResponse {
    submission: Submission,
}

fn require_admin(user: &AuthenticatedUser) -> Result<(), AppError> {
    if user.role == Role::Admin {
        Ok(())
    } else {
        Err(AppError::forbidden("admin authentication required"))
    }
}
