use std::convert::Infallible;

use axum::{
    Json, Router,
    extract::State,
    response::{
        Sse,
        sse::{Event, KeepAlive},
    },
    routing::{delete, get, post},
};
use serde::{Deserialize, Serialize};
use tokio_stream::wrappers::BroadcastStream;

use crate::{
    auth::AdminUser,
    error::AppError,
    models::{PreviewRunId, SubmissionId, TeamId},
    routes::game::GameStateResponse,
    routes::submissions::{
        LeaderboardEntry, leaderboard_entries, play_completed_submission_for_blackboard,
    },
    state::{
        AppEvent, AppState, BlackboardDisplay, BlackboardDisplayMode, BlackboardPreviewSessionView,
    },
};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/blackboard/state", get(blackboard_state))
        .route("/blackboard/events", get(blackboard_events))
        .route("/admin/blackboard/control", get(admin_blackboard_control))
        .route("/admin/blackboard/display", post(set_blackboard_display))
        .route(
            "/admin/blackboard/playback",
            delete(clear_blackboard_playback),
        )
}

#[derive(Debug, Serialize)]
struct BlackboardState {
    status: BlackboardStatus,
    display: BlackboardDisplay,
    selected_submission_id: Option<SubmissionId>,
    game: GameStateResponse,
    teams: Vec<BlackboardTeam>,
    preview_sessions: Vec<BlackboardPreviewSessionView>,
    leaderboard: Vec<LeaderboardEntry>,
}

#[derive(Debug, Serialize)]
struct BlackboardTeam {
    id: TeamId,
    name: String,
    enabled: bool,
    total_score: i32,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
enum BlackboardStatus {
    Idle,
}

async fn blackboard_state(
    State(state): State<AppState>,
) -> Result<Json<BlackboardState>, AppError> {
    let leaderboard = leaderboard_entries(state.repository.leaderboard()?);
    let teams = state
        .repository
        .list_teams()?
        .into_iter()
        .map(|team| BlackboardTeam {
            id: team.id,
            name: team.name,
            enabled: team.enabled,
            total_score: team.total_score,
        })
        .collect();
    let game_snapshot = state
        .game
        .snapshot(state.repository.as_ref(), None)
        .map_err(|error| AppError::internal(format!("game snapshot is unavailable: {error}")))?;
    let mut display = state.blackboard.display()?;
    if let Some(selected_submission_id) = display.selected_submission_id {
        if !game_snapshot
            .round_submissions
            .iter()
            .any(|submission| submission.id == selected_submission_id)
        {
            display.selected_submission_id = None;
        }
    }
    if let Some(preview_run_id) = display.selected_preview_run_id {
        if state
            .blackboard
            .preview_run(preview_run_id, game_snapshot.state.current_round_id)?
            .is_none()
        {
            display = BlackboardDisplay::default();
        }
    }
    let selected_submission_id = display.selected_submission_id;
    let preview_sessions = state
        .blackboard
        .preview_sessions(game_snapshot.state.current_round_id)?;
    let game = game_snapshot.into();

    Ok(Json(BlackboardState {
        status: BlackboardStatus::Idle,
        display,
        selected_submission_id,
        game,
        teams,
        preview_sessions,
        leaderboard,
    }))
}

#[derive(Debug, Serialize)]
struct BlackboardPlaybackSelection {
    selected_submission_id: Option<SubmissionId>,
}

async fn clear_blackboard_playback(
    AdminUser(_user): AdminUser,
    State(state): State<AppState>,
) -> Result<Json<BlackboardPlaybackSelection>, AppError> {
    let selected_submission_id = state.blackboard.set_selected_submission_id(None)?;
    state
        .event_bus
        .publish(AppEvent::BlackboardPlaybackChanged {
            submission_id: None,
        });
    state.event_bus.publish(AppEvent::BlackboardDisplayChanged {
        display: state.blackboard.display()?,
    });
    Ok(Json(BlackboardPlaybackSelection {
        selected_submission_id,
    }))
}

#[derive(Debug, Serialize)]
struct BlackboardControlState {
    display: BlackboardDisplay,
    selected_submission_id: Option<SubmissionId>,
    preview_sessions: Vec<BlackboardPreviewSessionView>,
}

async fn admin_blackboard_control(
    AdminUser(_user): AdminUser,
    State(state): State<AppState>,
) -> Result<Json<BlackboardControlState>, AppError> {
    let display = state.blackboard.display()?;
    let current_round_id = state
        .game
        .snapshot(state.repository.as_ref(), None)
        .map_err(|error| AppError::internal(format!("game snapshot is unavailable: {error}")))?
        .state
        .current_round_id;
    Ok(Json(BlackboardControlState {
        selected_submission_id: display.selected_submission_id,
        display,
        preview_sessions: state.blackboard.preview_sessions(current_round_id)?,
    }))
}

#[derive(Debug, Deserialize)]
struct SetBlackboardDisplayRequest {
    mode: BlackboardDisplayMode,
    submission_id: Option<SubmissionId>,
    preview_run_id: Option<PreviewRunId>,
}

async fn set_blackboard_display(
    AdminUser(_user): AdminUser,
    State(state): State<AppState>,
    Json(payload): Json<SetBlackboardDisplayRequest>,
) -> Result<Json<BlackboardControlState>, AppError> {
    let current_round_id = state
        .game
        .snapshot(state.repository.as_ref(), None)
        .map_err(|error| AppError::internal(format!("game snapshot is unavailable: {error}")))?
        .state
        .current_round_id;
    let display = match payload.mode {
        BlackboardDisplayMode::Submission => {
            if let Some(submission_id) = payload.submission_id {
                play_completed_submission_for_blackboard(&state, submission_id).await?;
                BlackboardDisplay {
                    mode: BlackboardDisplayMode::Submission,
                    selected_submission_id: Some(submission_id),
                    selected_preview_run_id: None,
                }
            } else {
                BlackboardDisplay::default()
            }
        }
        BlackboardDisplayMode::Preview => {
            let preview_run_id = payload
                .preview_run_id
                .ok_or_else(|| AppError::bad_request("preview_run_id is required"))?;
            state
                .blackboard
                .preview_run(preview_run_id, current_round_id)?
                .ok_or_else(|| AppError::not_found("preview run was not found"))?;
            BlackboardDisplay {
                mode: BlackboardDisplayMode::Preview,
                selected_submission_id: None,
                selected_preview_run_id: Some(preview_run_id),
            }
        }
    };
    let display = state.blackboard.set_display(display)?;
    if display.mode == BlackboardDisplayMode::Submission {
        state
            .event_bus
            .publish(AppEvent::BlackboardPlaybackChanged {
                submission_id: display.selected_submission_id,
            });
    }
    if display.mode == BlackboardDisplayMode::Preview {
        state
            .event_bus
            .publish(AppEvent::BlackboardPreviewPlaybackChanged {
                preview_run_id: display.selected_preview_run_id,
            });
    }
    state.event_bus.publish(AppEvent::BlackboardDisplayChanged {
        display: display.clone(),
    });
    Ok(Json(BlackboardControlState {
        selected_submission_id: display.selected_submission_id,
        display,
        preview_sessions: state.blackboard.preview_sessions(current_round_id)?,
    }))
}

async fn blackboard_events(
    State(state): State<AppState>,
) -> Sse<impl tokio_stream::Stream<Item = Result<Event, Infallible>>> {
    let stream = tokio_stream::StreamExt::filter_map(
        BroadcastStream::new(state.event_bus.subscribe()),
        |message| {
            let event = match message {
                Ok(event) => event,
                Err(_) => return None,
            };
            sse_json_event(&event)
        },
    );
    Sse::new(stream).keep_alive(KeepAlive::default())
}

fn sse_json_event(event: &AppEvent) -> Option<Result<Event, Infallible>> {
    serde_json::to_string(event)
        .ok()
        .map(|data| Ok(Event::default().event("message").data(data)))
}
