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
    leaderboard: Vec<LeaderboardEntry>,
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

    Ok(Json(BlackboardState {
        status: BlackboardStatus::Idle,
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
