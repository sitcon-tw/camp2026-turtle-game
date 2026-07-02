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
    models::TeamId,
    routes::game::GameStateResponse,
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
    game: GameStateResponse,
    teams: Vec<BlackboardTeam>,
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
    let game = state
        .game
        .snapshot(state.repository.as_ref(), None)
        .map_err(|error| AppError::internal(format!("game snapshot is unavailable: {error}")))?
        .into();

    Ok(Json(BlackboardState {
        status: BlackboardStatus::Idle,
        game,
        teams,
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
