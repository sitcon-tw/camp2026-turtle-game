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
        .route(
            "/admin/submissions/{submission_id}",
            get(get_submission).delete(delete_submission),
        )
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

async fn delete_submission(
    State(state): State<AppState>,
    user: AuthenticatedUser,
    Path(submission_id): Path<SubmissionId>,
) -> Result<Json<DeleteSubmissionResponse>, AppError> {
    require_admin(&user)?;
    let submission = state
        .repository
        .get_submission(submission_id)?
        .ok_or_else(|| AppError::not_found("submission was not found"))?;
    state
        .repository
        .delete_submissions_and_score_events(&[submission.id])?;
    state.repository.recalculate_scores_from_events()?;
    if state
        .blackboard
        .selected_submission_id()?
        .is_some_and(|selected_submission_id| selected_submission_id == submission.id)
    {
        state.blackboard.set_selected_submission_id(None)?;
        state
            .event_bus
            .publish(crate::state::AppEvent::BlackboardPlaybackChanged {
                submission_id: None,
            });
        state
            .event_bus
            .publish(crate::state::AppEvent::BlackboardDisplayChanged {
                display: state.blackboard.display()?,
            });
    }
    state
        .event_bus
        .publish(crate::state::AppEvent::LeaderboardUpdated);
    Ok(Json(DeleteSubmissionResponse {
        deleted: true,
        submission_id: submission.id,
    }))
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
    Ok(Json(RetryResponse { submission: retry }))
}

#[derive(Debug, Serialize)]
struct RetryResponse {
    submission: Submission,
}

#[derive(Debug, Serialize)]
struct DeleteSubmissionResponse {
    deleted: bool,
    submission_id: SubmissionId,
}

fn require_admin(user: &AuthenticatedUser) -> Result<(), AppError> {
    if user.role == Role::Admin {
        Ok(())
    } else {
        Err(AppError::forbidden("admin authentication required"))
    }
}
