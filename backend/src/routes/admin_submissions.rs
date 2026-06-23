use axum::{
    Json, Router,
    extract::{Path, Query, State},
    routing::{get, post},
};
use serde::{Deserialize, Serialize};

use crate::{
    auth::AuthenticatedUser,
    error::AppError,
    models::{Role, Submission, SubmissionId},
    state::{AppEvent, AppState, SubmissionListFilter},
};

const PRIORITY_BASE: i32 = 1_000_000;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/admin/submissions", get(list_submissions))
        .route("/admin/submissions/{submission_id}", get(get_submission))
        .route(
            "/admin/submissions/{submission_id}/retry",
            post(retry_submission),
        )
        .route(
            "/admin/submissions/{submission_id}/cancel",
            post(cancel_submission),
        )
        .route("/admin/judge-queue", get(judge_queue))
        .route("/admin/judge-queue/pause", post(pause_queue))
        .route("/admin/judge-queue/resume", post(resume_queue))
        .route(
            "/admin/judge-queue/{submission_id}/prioritize",
            post(prioritize_submission),
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
    let position = state.repository.queue_position(retry.id)?;
    state.event_bus.publish(AppEvent::SubmissionUpdated {
        submission_id: retry.id,
    });
    Ok(Json(RetryResponse {
        submission: retry,
        position,
    }))
}

async fn cancel_submission(
    State(state): State<AppState>,
    user: AuthenticatedUser,
    Path(submission_id): Path<SubmissionId>,
) -> Result<Json<Submission>, AppError> {
    require_admin(&user)?;
    let submission = state.repository.cancel_queued_submission(submission_id)?;
    state.event_bus.publish(AppEvent::SubmissionUpdated {
        submission_id: submission.id,
    });
    Ok(Json(submission))
}

async fn judge_queue(
    State(state): State<AppState>,
    user: AuthenticatedUser,
) -> Result<Json<JudgeQueueResponse>, AppError> {
    require_admin(&user)?;
    let paused = state.is_queue_paused()?;
    let submissions = state.repository.list_queued_running_submissions()?;
    Ok(Json(JudgeQueueResponse {
        paused,
        queue_length: submissions
            .iter()
            .filter(|submission| submission.status == crate::models::SubmissionStatus::Queued)
            .count(),
        submissions,
    }))
}

async fn pause_queue(
    State(state): State<AppState>,
    user: AuthenticatedUser,
) -> Result<Json<QueuePauseResponse>, AppError> {
    require_admin(&user)?;
    let paused = state.set_queue_paused(true)?;
    Ok(Json(QueuePauseResponse { paused }))
}

async fn resume_queue(
    State(state): State<AppState>,
    user: AuthenticatedUser,
) -> Result<Json<QueuePauseResponse>, AppError> {
    require_admin(&user)?;
    let paused = state.set_queue_paused(false)?;
    Ok(Json(QueuePauseResponse { paused }))
}

#[derive(Debug, Deserialize)]
struct PrioritizeRequest {
    position: usize,
}

async fn prioritize_submission(
    State(state): State<AppState>,
    user: AuthenticatedUser,
    Path(submission_id): Path<SubmissionId>,
    Json(payload): Json<PrioritizeRequest>,
) -> Result<Json<Submission>, AppError> {
    require_admin(&user)?;
    if payload.position == 0 {
        return Err(AppError::bad_request("position must be one or greater"));
    }
    let offset = i32::try_from(payload.position).unwrap_or(i32::MAX);
    let priority = PRIORITY_BASE.saturating_sub(offset);
    let submission = state
        .repository
        .prioritize_submission(submission_id, priority)?;
    state.event_bus.publish(AppEvent::SubmissionUpdated {
        submission_id: submission.id,
    });
    Ok(Json(submission))
}

#[derive(Debug, Serialize)]
struct RetryResponse {
    submission: Submission,
    position: Option<usize>,
}

#[derive(Debug, Serialize)]
struct JudgeQueueResponse {
    paused: bool,
    queue_length: usize,
    submissions: Vec<Submission>,
}

#[derive(Debug, Serialize)]
struct QueuePauseResponse {
    paused: bool,
}

fn require_admin(user: &AuthenticatedUser) -> Result<(), AppError> {
    if user.role == Role::Admin {
        Ok(())
    } else {
        Err(AppError::forbidden("admin authentication required"))
    }
}
