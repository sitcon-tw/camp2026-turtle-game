use std::{convert::Infallible, time::Duration as StdDuration};

use axum::{
    Json, Router,
    body::Body,
    extract::{
        Path, Query, State,
        ws::{Message, WebSocket, WebSocketUpgrade},
    },
    http::{HeaderValue, StatusCode, header},
    response::{
        IntoResponse, Response,
        Sse,
        sse::{Event, KeepAlive},
    },
    routing::{delete, get, post},
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tokio_stream::{StreamExt, wrappers::BroadcastStream};
use uuid::Uuid;

use crate::{
    auth::{AdminUser, verify_token},
    error::AppError,
    models::{Role, SubmissionId, TeamId},
    routes::game::GameStateResponse,
    routes::submissions::{
        LeaderboardEntry, leaderboard_entries, play_completed_submission_for_blackboard,
    },
    state::{
        AppEvent, AppState, BlackboardDisplay, BlackboardDisplayMode, BlackboardStreamFrame,
        BlackboardStreamSessionView,
    },
};

const MAX_STREAM_FRAME_BYTES: usize = 700 * 1024;
const STREAM_FRAME_WAIT_MS: u64 = 1_500;
const STREAM_FRAME_POLL_MS: u64 = 80;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/blackboard/state", get(blackboard_state))
        .route("/blackboard/events", get(blackboard_events))
        .route("/blackboard/stream/team", get(team_stream_socket))
        .route("/blackboard/stream/frame", get(selected_stream_frame))
        .route("/admin/blackboard/control", get(admin_blackboard_control))
        .route("/admin/blackboard/display", post(set_blackboard_display))
        .route(
            "/admin/blackboard/stream-sessions/{session_id}/frame",
            get(admin_stream_session_frame),
        )
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
    stream_sessions: Vec<BlackboardStreamSessionView>,
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
    if let Some(session_id) = display.selected_stream_session_id.as_deref() {
        if state.blackboard.stream_session(session_id)?.is_none() {
            display.selected_stream_session_id = None;
        }
    }
    let selected_submission_id = display.selected_submission_id;
    let game = game_snapshot.into();

    Ok(Json(BlackboardState {
        status: BlackboardStatus::Idle,
        display,
        selected_submission_id,
        game,
        teams,
        stream_sessions: state.blackboard.stream_sessions()?,
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
    state
        .event_bus
        .publish(AppEvent::BlackboardDisplayChanged {
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
    stream_sessions: Vec<BlackboardStreamSessionView>,
}

async fn admin_blackboard_control(
    AdminUser(_user): AdminUser,
    State(state): State<AppState>,
) -> Result<Json<BlackboardControlState>, AppError> {
    let display = state.blackboard.display()?;
    Ok(Json(BlackboardControlState {
        selected_submission_id: display.selected_submission_id,
        display,
        stream_sessions: state.blackboard.stream_sessions()?,
    }))
}

#[derive(Debug, Deserialize)]
struct SetBlackboardDisplayRequest {
    mode: BlackboardDisplayMode,
    submission_id: Option<SubmissionId>,
    stream_session_id: Option<String>,
}

async fn set_blackboard_display(
    AdminUser(_user): AdminUser,
    State(state): State<AppState>,
    Json(payload): Json<SetBlackboardDisplayRequest>,
) -> Result<Json<BlackboardControlState>, AppError> {
    let display = match payload.mode {
        BlackboardDisplayMode::Submission => {
            if let Some(submission_id) = payload.submission_id {
                play_completed_submission_for_blackboard(&state, submission_id).await?;
                BlackboardDisplay {
                    mode: BlackboardDisplayMode::Submission,
                    selected_submission_id: Some(submission_id),
                    selected_stream_session_id: None,
                }
            } else {
                BlackboardDisplay::default()
            }
        }
        BlackboardDisplayMode::Stream => {
            let session_id = payload
                .stream_session_id
                .ok_or_else(|| AppError::bad_request("stream_session_id is required"))?;
            state
                .blackboard
                .stream_session(&session_id)?
                .ok_or_else(|| AppError::not_found("stream session was not found"))?;
            BlackboardDisplay {
                mode: BlackboardDisplayMode::Stream,
                selected_submission_id: None,
                selected_stream_session_id: Some(session_id),
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
    state
        .event_bus
        .publish(AppEvent::BlackboardDisplayChanged {
            display: display.clone(),
        });
    Ok(Json(BlackboardControlState {
        selected_submission_id: display.selected_submission_id,
        display,
        stream_sessions: state.blackboard.stream_sessions()?,
    }))
}

async fn team_stream_socket(
    State(state): State<AppState>,
    upgrade: WebSocketUpgrade,
) -> impl IntoResponse {
    upgrade.on_upgrade(move |socket| handle_team_stream_socket(state, socket))
}

#[derive(Debug, Deserialize)]
struct StreamHello {
    #[serde(default)]
    r#type: String,
    token: String,
    session_id: String,
    device_id: String,
}

#[derive(Debug, Serialize)]
struct StreamControlMessage {
    r#type: &'static str,
    desired_fps: u8,
}

async fn handle_team_stream_socket(state: AppState, mut socket: WebSocket) {
    let Some(Ok(Message::Text(hello_text))) = socket.recv().await else {
        return;
    };
    let Ok(hello) = serde_json::from_str::<StreamHello>(&hello_text) else {
        let _ = socket
            .send(Message::Text(
                json!({ "type": "stream_error", "message": "hello payload is invalid" })
                    .to_string()
                    .into(),
            ))
            .await;
        return;
    };
    if hello.r#type != "hello" || hello.session_id.trim().is_empty() {
        let _ = socket
            .send(Message::Text(
                json!({ "type": "stream_error", "message": "hello payload is invalid" })
                    .to_string()
                    .into(),
            ))
            .await;
        return;
    }
    let Ok(user) = verify_token(&hello.token, &state.auth_secret) else {
        let _ = socket
            .send(Message::Text(
                json!({ "type": "stream_error", "message": "token is invalid" })
                    .to_string()
                    .into(),
            ))
            .await;
        return;
    };
    if user.role != Role::Team {
        let _ = socket
            .send(Message::Text(
                json!({ "type": "stream_error", "message": "team authentication is required" })
                    .to_string()
                    .into(),
            ))
            .await;
        return;
    }
    let Ok(team_uuid) = Uuid::parse_str(&user.subject) else {
        return;
    };
    let team_id = TeamId::from(team_uuid);
    match state.repository.get_team(team_id) {
        Ok(Some(team)) if team.enabled => {}
        _ => return,
    }

    if state
        .blackboard
        .register_stream_session(hello.session_id.clone(), team_id, hello.device_id)
        .is_err()
    {
        return;
    }
    publish_display_changed(&state);
    send_stream_control(&state, &mut socket, &hello.session_id).await;

    while let Some(message) = socket.recv().await {
        let Ok(message) = message else {
            break;
        };
        match message {
            Message::Binary(bytes) => {
                if bytes.len() <= MAX_STREAM_FRAME_BYTES {
                    let _ = state
                        .blackboard
                        .store_stream_frame(&hello.session_id, bytes.to_vec());
                    publish_display_changed(&state);
                }
                send_stream_control(&state, &mut socket, &hello.session_id).await;
            }
            Message::Close(_) => break,
            Message::Ping(bytes) => {
                let _ = socket.send(Message::Pong(bytes)).await;
            }
            _ => {}
        }
    }

    let _ = state.blackboard.disconnect_stream_session(&hello.session_id);
    publish_display_changed(&state);
}

async fn send_stream_control(state: &AppState, socket: &mut WebSocket, session_id: &str) {
    let desired_fps = state.blackboard.desired_fps_for_session(session_id).unwrap_or(1);
    if let Ok(payload) = serde_json::to_string(&StreamControlMessage {
        r#type: "stream_control",
        desired_fps,
    }) {
        let _ = socket.send(Message::Text(payload.into())).await;
    }
}

fn publish_display_changed(state: &AppState) {
    if let Ok(display) = state.blackboard.display() {
        state
            .event_bus
            .publish(AppEvent::BlackboardDisplayChanged { display });
    }
}

#[derive(Debug, Deserialize)]
struct StreamFrameQuery {
    after: Option<u64>,
}

async fn selected_stream_frame(
    State(state): State<AppState>,
    Query(query): Query<StreamFrameQuery>,
) -> Result<Response, AppError> {
    let after = query.after.unwrap_or(0);
    let deadline = tokio::time::Instant::now() + StdDuration::from_millis(STREAM_FRAME_WAIT_MS);
    loop {
        if let Some(frame) = state.blackboard.selected_stream_frame()? {
            if frame.seq > after {
                return Ok(stream_frame_response(frame));
            }
        }
        if tokio::time::Instant::now() >= deadline {
            return Ok(StatusCode::NO_CONTENT.into_response());
        }
        tokio::time::sleep(StdDuration::from_millis(STREAM_FRAME_POLL_MS)).await;
    }
}

async fn admin_stream_session_frame(
    AdminUser(_user): AdminUser,
    State(state): State<AppState>,
    Path(session_id): Path<String>,
    Query(query): Query<StreamFrameQuery>,
) -> Result<Response, AppError> {
    let after = query.after.unwrap_or(0);
    let Some(frame) = state.blackboard.stream_frame(&session_id)? else {
        return Ok(StatusCode::NO_CONTENT.into_response());
    };
    if frame.seq <= after {
        return Ok(StatusCode::NO_CONTENT.into_response());
    }
    Ok(stream_frame_response(frame))
}

fn stream_frame_response(frame: BlackboardStreamFrame) -> Response {
    let mut response = Response::new(Body::from(frame.bytes));
    let headers = response.headers_mut();
    headers.insert(header::CONTENT_TYPE, HeaderValue::from_static("image/jpeg"));
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("no-store, max-age=0"),
    );
    if let Ok(value) = HeaderValue::from_str(&frame.seq.to_string()) {
        headers.insert("x-frame-seq", value);
    }
    if let Ok(value) = HeaderValue::from_str(&frame.session_id) {
        headers.insert("x-stream-session-id", value);
    }
    if let Ok(value) = HeaderValue::from_str(&frame.team_id.as_uuid().to_string()) {
        headers.insert("x-stream-team-id", value);
    }
    if let Ok(value) = HeaderValue::from_str(&frame.captured_at.to_rfc3339()) {
        headers.insert("x-frame-captured-at", value);
    }
    response
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
