use std::convert::Infallible;

use axum::{
    Json, Router,
    extract::State,
    response::{
        Sse,
        sse::{Event, KeepAlive},
    },
    routing::get,
};
use serde::Serialize;
use tokio_stream::{StreamExt, wrappers::BroadcastStream};

use crate::{
    error::AppError,
    models::{Submission, SubmissionStatus},
    routes::submissions::{LeaderboardEntry, leaderboard_entries},
    state::{AppEvent, AppState},
};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/blackboard/state", get(blackboard_state))
        .route("/blackboard/events", get(blackboard_events))
}

#[derive(Debug, Serialize)]
struct BlackboardState {
    status: BlackboardStatus,
    paused: bool,
    queue_length: usize,
    running: Vec<Submission>,
    leaderboard: Vec<LeaderboardEntry>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
enum BlackboardStatus {
    Idle,
    Running,
    Paused,
}

async fn blackboard_state(
    State(state): State<AppState>,
) -> Result<Json<BlackboardState>, AppError> {
    let paused = state.is_queue_paused()?;
    let queue = state.repository.list_queued_running_submissions()?;
    let queue_length = queue
        .iter()
        .filter(|submission| submission.status == SubmissionStatus::Queued)
        .count();
    let running: Vec<_> = queue
        .into_iter()
        .filter(|submission| submission.status == SubmissionStatus::Running)
        .collect();
    let status = if paused {
        BlackboardStatus::Paused
    } else if running.is_empty() {
        BlackboardStatus::Idle
    } else {
        BlackboardStatus::Running
    };
    let leaderboard = leaderboard_entries(state.repository.leaderboard()?);

    Ok(Json(BlackboardState {
        status,
        paused,
        queue_length,
        running,
        leaderboard,
    }))
}

async fn blackboard_events(
    State(state): State<AppState>,
) -> Sse<impl tokio_stream::Stream<Item = Result<Event, Infallible>>> {
    let stream = BroadcastStream::new(state.event_bus.subscribe()).filter_map(|message| {
        let event = match message {
            Ok(event) => event,
            Err(_) => return None,
        };
        sse_json_event(&event)
    });
    Sse::new(stream).keep_alive(KeepAlive::default())
}

fn sse_json_event(event: &AppEvent) -> Option<Result<Event, Infallible>> {
    serde_json::to_string(event)
        .ok()
        .map(|data| Ok(Event::default().event("message").data(data)))
}
