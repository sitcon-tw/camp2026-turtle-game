use axum::{
    Json, Router,
    extract::{Query, State},
    routing::{get, post},
};
use serde::{Deserialize, Serialize};

use crate::{
    auth::AuthenticatedUser,
    error::AppError,
    models::{Role, ScoreEvent, ScoreEventId, Team, TeamId},
    state::{AppEvent, AppState, ScoreEventInput, ScoreEventListFilter},
};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/admin/score-events", get(list_score_events))
        .route("/admin/scores/bulk-adjust", post(bulk_adjust_scores))
        .route("/admin/scores/recalculate", post(recalculate_scores))
        .route(
            "/admin/scores/recalculate-challenge-awards",
            post(recalculate_challenge_awards),
        )
}

async fn list_score_events(
    State(state): State<AppState>,
    user: AuthenticatedUser,
    Query(filter): Query<ScoreEventListFilter>,
) -> Result<Json<Vec<ScoreEvent>>, AppError> {
    require_admin(&user)?;
    Ok(Json(state.repository.list_score_events(filter)?))
}

#[derive(Debug, Deserialize)]
#[serde(tag = "operation", rename_all = "snake_case")]
enum BulkAdjustRequest {
    Add {
        team_ids: Vec<TeamId>,
        amount: i32,
        reason: Option<String>,
    },
    Subtract {
        team_ids: Vec<TeamId>,
        amount: i32,
        reason: Option<String>,
    },
    Set {
        team_ids: Vec<TeamId>,
        target_score: i32,
        reason: Option<String>,
    },
}

#[derive(Debug, Serialize)]
struct BulkAdjustResponse {
    updated_teams: Vec<BulkAdjustedTeam>,
}

#[derive(Debug, Serialize)]
struct BulkAdjustedTeam {
    team_id: TeamId,
    score_before: i32,
    score_after: i32,
    delta: i32,
    score_event_id: ScoreEventId,
}

async fn bulk_adjust_scores(
    State(state): State<AppState>,
    user: AuthenticatedUser,
    Json(payload): Json<BulkAdjustRequest>,
) -> Result<Json<BulkAdjustResponse>, AppError> {
    require_admin(&user)?;
    let created_by = user.subject.clone();
    let inputs = payload.into_score_event_inputs(created_by)?;
    let events = state.repository.append_score_events_bulk(inputs)?;
    for event in &events {
        state.event_bus.publish(AppEvent::ScoreRecorded {
            score_event: event.clone(),
        });
    }
    Ok(Json(BulkAdjustResponse {
        updated_teams: events.into_iter().map(BulkAdjustedTeam::from).collect(),
    }))
}

impl BulkAdjustRequest {
    fn into_score_event_inputs(self, created_by: String) -> Result<Vec<ScoreEventInput>, AppError> {
        match self {
            Self::Add {
                team_ids,
                amount,
                reason,
            } => {
                validate_bulk_adjust(&team_ids, amount, reason.as_deref(), "amount")?;
                let reason = required_reason(reason)?;
                Ok(team_ids
                    .into_iter()
                    .map(|team_id| {
                        ScoreEventInput::admin_add(
                            team_id,
                            amount,
                            reason.clone(),
                            created_by.clone(),
                        )
                    })
                    .collect())
            }
            Self::Subtract {
                team_ids,
                amount,
                reason,
            } => {
                validate_bulk_adjust(&team_ids, amount, reason.as_deref(), "amount")?;
                let reason = required_reason(reason)?;
                Ok(team_ids
                    .into_iter()
                    .map(|team_id| {
                        ScoreEventInput::admin_subtract(
                            team_id,
                            amount,
                            reason.clone(),
                            created_by.clone(),
                        )
                    })
                    .collect())
            }
            Self::Set {
                team_ids,
                target_score,
                reason,
            } => {
                validate_bulk_adjust(&team_ids, target_score, reason.as_deref(), "target_score")?;
                let reason = required_reason(reason)?;
                Ok(team_ids
                    .into_iter()
                    .map(|team_id| {
                        ScoreEventInput::admin_set(
                            team_id,
                            target_score,
                            reason.clone(),
                            created_by.clone(),
                        )
                    })
                    .collect())
            }
        }
    }
}

fn validate_bulk_adjust(
    team_ids: &[TeamId],
    score_value: i32,
    reason: Option<&str>,
    score_field: &str,
) -> Result<(), AppError> {
    if team_ids.is_empty() {
        return Err(AppError::bad_request("team_ids must not be empty"));
    }
    if score_value < 0 {
        return Err(AppError::bad_request(format!(
            "{score_field} must not be negative"
        )));
    }
    if reason.is_none_or(|value| value.trim().is_empty()) {
        return Err(AppError::bad_request("reason is required"));
    }
    Ok(())
}

fn required_reason(reason: Option<String>) -> Result<String, AppError> {
    reason
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| AppError::bad_request("reason is required"))
}

impl From<ScoreEvent> for BulkAdjustedTeam {
    fn from(event: ScoreEvent) -> Self {
        Self {
            team_id: event.team_id,
            score_before: event.score_before,
            score_after: event.score_after,
            delta: event.delta,
            score_event_id: event.id,
        }
    }
}

#[derive(Debug, Serialize)]
struct RecalculateResponse {
    teams: Vec<Team>,
}

async fn recalculate_scores(
    State(state): State<AppState>,
    user: AuthenticatedUser,
) -> Result<Json<RecalculateResponse>, AppError> {
    require_admin(&user)?;
    let teams = state.repository.recalculate_scores_from_events()?;
    Ok(Json(RecalculateResponse { teams }))
}

async fn recalculate_challenge_awards(
    State(state): State<AppState>,
    user: AuthenticatedUser,
) -> Result<Json<RecalculateResponse>, AppError> {
    require_admin(&user)?;
    let teams = state.repository.recalculate_challenge_pass_awards()?;
    Ok(Json(RecalculateResponse { teams }))
}

fn require_admin(user: &AuthenticatedUser) -> Result<(), AppError> {
    if user.role == Role::Admin {
        Ok(())
    } else {
        Err(AppError::forbidden("admin authentication required"))
    }
}
