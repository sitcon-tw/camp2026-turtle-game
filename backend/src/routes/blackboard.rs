use std::{convert::Infallible, time::Duration as StdDuration};

use axum::{
    Json, Router,
    extract::{
        Path, Query, State,
        ws::{Message, WebSocket, WebSocketUpgrade},
    },
    response::{
        IntoResponse, Sse,
        sse::{Event, KeepAlive},
    },
    routing::{delete, get, post},
};
use futures_util::{SinkExt, StreamExt as FuturesStreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::sync::mpsc;
use tokio_stream::wrappers::BroadcastStream;
use uuid::Uuid;

use crate::{
    auth::{AdminUser, verify_token},
    error::AppError,
    models::{PreviewRunId, Role, SubmissionId, TeamId},
    routes::game::GameStateResponse,
    routes::submissions::{
        LeaderboardEntry, leaderboard_entries, play_completed_submission_for_blackboard,
    },
    state::{
        AppEvent, AppState, BlackboardDisplay, BlackboardDisplayMode,
        BlackboardPreviewSessionView, BlackboardStreamSessionView, BlackboardViewerKind, StoreError,
    },
};

const STREAM_SESSION_OFFLINE_EXPIRY_SECS: u64 = 30;
const PUBLIC_STREAM_TARGET_FPS: u8 = 60;
const ADMIN_PREVIEW_TARGET_FPS: u8 = 2;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/blackboard/state", get(blackboard_state))
        .route("/blackboard/events", get(blackboard_events))
        .route("/blackboard/stream/team", get(team_stream_socket))
        .route("/blackboard/stream/viewer", get(stream_viewer_socket))
        .route("/admin/blackboard/control", get(admin_blackboard_control))
        .route("/admin/blackboard/display", post(set_blackboard_display))
        .route(
            "/admin/blackboard/stream-sessions/{session_id}/viewer",
            get(admin_stream_session_viewer_socket),
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
    if let Some(session_id) = display.selected_stream_session_id.as_deref() {
        if state.blackboard.stream_session(session_id)?.is_none() {
            display.selected_stream_session_id = None;
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
        stream_sessions: state.blackboard.stream_sessions()?,
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
    stream_sessions: Vec<BlackboardStreamSessionView>,
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
        stream_sessions: state.blackboard.stream_sessions()?,
        preview_sessions: state.blackboard.preview_sessions(current_round_id)?,
    }))
}

#[derive(Debug, Deserialize)]
struct SetBlackboardDisplayRequest {
    mode: BlackboardDisplayMode,
    submission_id: Option<SubmissionId>,
    stream_session_id: Option<String>,
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
                    selected_stream_session_id: None,
                    selected_preview_run_id: None,
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
                selected_preview_run_id: None,
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
                selected_stream_session_id: None,
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
    state
        .blackboard_signaling
        .close_public_viewers_except(display.selected_stream_session_id.as_deref())
        .await;
    Ok(Json(BlackboardControlState {
        selected_submission_id: display.selected_submission_id,
        display,
        stream_sessions: state.blackboard.stream_sessions()?,
        preview_sessions: state.blackboard.preview_sessions(current_round_id)?,
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

    let connection_id = Uuid::new_v4().to_string();
    match state.blackboard.register_stream_session(
        hello.session_id.clone(),
        team_id,
        hello.device_id,
        connection_id.clone(),
    ) {
        Ok(_) => {}
        Err(StoreError::InvalidatedStreamSession) => {
            send_stream_error(
                &mut socket,
                "stream_session_invalid",
                "stream session id is invalid",
            )
            .await;
            return;
        }
        Err(_) => return,
    }
    publish_display_changed(&state);
    let (signal_tx, mut signal_rx) = mpsc::unbounded_channel();
    state
        .blackboard_signaling
        .register_team(hello.session_id.clone(), connection_id.clone(), signal_tx)
        .await;

    let (mut socket_sender, mut socket_receiver) = socket.split();

    loop {
        tokio::select! {
            outbound = signal_rx.recv() => {
                let Some(outbound) = outbound else {
                    break;
                };
                if socket_sender.send(Message::Text(outbound.into())).await.is_err() {
                    break;
                }
            }
            message = FuturesStreamExt::next(&mut socket_receiver) => {
                let Some(message) = message else {
                    break;
                };
                let Ok(message) = message else {
                    break;
                };
                match message {
                    Message::Text(text) => {
                        handle_team_signal_message(&state, &text).await;
                    }
                    Message::Close(_) => break,
                    Message::Ping(bytes) => {
                        let _ = socket_sender.send(Message::Pong(bytes)).await;
                    }
                    _ => {}
                }
            }
        }
    }

    state
        .blackboard_signaling
        .unregister_team(&hello.session_id, &connection_id)
        .await;
    if state
        .blackboard
        .disconnect_stream_session(&hello.session_id, &connection_id)
        .unwrap_or(false)
    {
        publish_display_changed(&state);
        schedule_stream_session_expiration_after(
            state,
            hello.session_id,
            connection_id,
            StdDuration::from_secs(STREAM_SESSION_OFFLINE_EXPIRY_SECS),
        );
    }
}

#[derive(Debug, Deserialize)]
struct TeamSignalMessage {
    #[serde(default)]
    r#type: String,
    viewer_id: String,
    sdp: Option<String>,
    candidate: Option<Value>,
}

async fn handle_team_signal_message(state: &AppState, text: &str) {
    let Ok(message) = serde_json::from_str::<TeamSignalMessage>(text) else {
        return;
    };
    let payload = match message.r#type.as_str() {
        "webrtc_offer" => json!({
            "type": "webrtc_offer",
            "viewer_id": message.viewer_id,
            "sdp": message.sdp,
        }),
        "webrtc_ice_candidate" => json!({
            "type": "webrtc_ice_candidate",
            "viewer_id": message.viewer_id,
            "candidate": message.candidate,
        }),
        _ => return,
    };
    let _ = state
        .blackboard_signaling
        .send_to_viewer(&message.viewer_id, payload.to_string())
        .await;
}

async fn send_stream_error(socket: &mut WebSocket, code: &'static str, message: &'static str) {
    let _ = socket
        .send(Message::Text(
            json!({ "type": "stream_error", "code": code, "message": message })
                .to_string()
                .into(),
        ))
        .await;
}

#[derive(Debug, Deserialize)]
struct StreamViewerQuery {
    session_id: String,
}

async fn stream_viewer_socket(
    State(state): State<AppState>,
    Query(query): Query<StreamViewerQuery>,
    upgrade: WebSocketUpgrade,
) -> impl IntoResponse {
    upgrade.on_upgrade(move |socket| {
        handle_stream_viewer_socket(
            state,
            socket,
            query.session_id,
            BlackboardViewerKind::Public,
            PUBLIC_STREAM_TARGET_FPS,
        )
    })
}

async fn admin_stream_session_viewer_socket(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
    upgrade: WebSocketUpgrade,
) -> impl IntoResponse {
    upgrade.on_upgrade(move |socket| handle_admin_stream_viewer_socket(state, socket, session_id))
}

#[derive(Debug, Deserialize)]
struct AdminViewerHello {
    #[serde(default)]
    r#type: String,
    token: String,
}

#[derive(Debug, Deserialize)]
struct ViewerSignalMessage {
    #[serde(default)]
    r#type: String,
    sdp: Option<String>,
    candidate: Option<Value>,
}

async fn handle_admin_stream_viewer_socket(
    state: AppState,
    mut socket: WebSocket,
    session_id: String,
) {
    let Some(Ok(Message::Text(hello_text))) = socket.recv().await else {
        return;
    };
    let Ok(hello) = serde_json::from_str::<AdminViewerHello>(&hello_text) else {
        send_stream_error(
            &mut socket,
            "admin_auth_required",
            "admin authentication is required",
        )
        .await;
        return;
    };
    if hello.r#type != "hello" {
        send_stream_error(
            &mut socket,
            "admin_auth_required",
            "admin authentication is required",
        )
        .await;
        return;
    }
    let Ok(user) = verify_token(&hello.token, &state.auth_secret) else {
        send_stream_error(&mut socket, "token_invalid", "token is invalid").await;
        return;
    };
    if user.role != Role::Admin {
        send_stream_error(
            &mut socket,
            "admin_auth_required",
            "admin authentication is required",
        )
        .await;
        return;
    }

    handle_stream_viewer_socket(
        state,
        socket,
        session_id,
        BlackboardViewerKind::AdminPreview,
        ADMIN_PREVIEW_TARGET_FPS,
    )
    .await;
}

async fn handle_stream_viewer_socket(
    state: AppState,
    mut socket: WebSocket,
    session_id: String,
    kind: BlackboardViewerKind,
    target_fps: u8,
) {
    if kind == BlackboardViewerKind::Public && !selected_stream_session_matches(&state, &session_id)
    {
        send_stream_error(
            &mut socket,
            "stream_session_not_selected",
            "stream session is not selected for blackboard display",
        )
        .await;
        return;
    }

    let viewer_id = Uuid::new_v4().to_string();
    let (signal_tx, mut signal_rx) = mpsc::unbounded_channel();
    if !state
        .blackboard_signaling
        .register_viewer(
            session_id.clone(),
            viewer_id.clone(),
            kind,
            target_fps,
            signal_tx,
        )
        .await
    {
        send_stream_error(
            &mut socket,
            "stream_session_unavailable",
            "stream session is not connected",
        )
        .await;
        return;
    }

    let (mut socket_sender, mut socket_receiver) = socket.split();
    let ready = json!({
        "type": "webrtc_viewer_ready",
        "viewer_id": viewer_id,
        "session_id": session_id,
        "viewer_kind": kind.as_str(),
        "target_fps": target_fps,
    });
    if socket_sender
        .send(Message::Text(ready.to_string().into()))
        .await
        .is_err()
    {
        state
            .blackboard_signaling
            .unregister_viewer(&viewer_id)
            .await;
        return;
    }

    loop {
        tokio::select! {
            outbound = signal_rx.recv() => {
                let Some(outbound) = outbound else {
                    break;
                };
                if socket_sender.send(Message::Text(outbound.into())).await.is_err() {
                    break;
                }
            }
            message = FuturesStreamExt::next(&mut socket_receiver) => {
                let Some(message) = message else {
                    break;
                };
                let Ok(message) = message else {
                    break;
                };
                match message {
                    Message::Text(text) => {
                        handle_viewer_signal_message(&state, &session_id, &viewer_id, &text).await;
                    }
                    Message::Close(_) => break,
                    Message::Ping(bytes) => {
                        let _ = socket_sender.send(Message::Pong(bytes)).await;
                    }
                    _ => {}
                }
            }
        }
    }

    state
        .blackboard_signaling
        .unregister_viewer(&viewer_id)
        .await;
}

fn selected_stream_session_matches(state: &AppState, session_id: &str) -> bool {
    state.blackboard.display().ok().is_some_and(|display| {
        display.mode == BlackboardDisplayMode::Stream
            && display
                .selected_stream_session_id
                .as_deref()
                .is_some_and(|selected| selected == session_id)
    })
}

async fn handle_viewer_signal_message(
    state: &AppState,
    session_id: &str,
    viewer_id: &str,
    text: &str,
) {
    let Ok(message) = serde_json::from_str::<ViewerSignalMessage>(text) else {
        return;
    };
    let payload = match message.r#type.as_str() {
        "webrtc_answer" => json!({
            "type": "webrtc_answer",
            "viewer_id": viewer_id,
            "sdp": message.sdp,
        }),
        "webrtc_ice_candidate" => json!({
            "type": "webrtc_ice_candidate",
            "viewer_id": viewer_id,
            "candidate": message.candidate,
        }),
        _ => return,
    };
    let _ = state
        .blackboard_signaling
        .send_to_team(session_id, payload.to_string())
        .await;
}

fn schedule_stream_session_expiration_after(
    state: AppState,
    session_id: String,
    connection_id: String,
    delay: StdDuration,
) {
    tokio::spawn(async move {
        tokio::time::sleep(delay).await;
        if state
            .blackboard
            .expire_disconnected_stream_session(&session_id, &connection_id)
            .unwrap_or(false)
        {
            publish_display_changed(&state);
        }
    });
}

fn publish_display_changed(state: &AppState) {
    if let Ok(display) = state.blackboard.display() {
        state
            .event_bus
            .publish(AppEvent::BlackboardDisplayChanged { display });
    }
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Config;

    #[tokio::test]
    async fn scheduled_expiration_removes_disconnected_session_and_invalidates_id() {
        let state = AppState::new(Config::default());
        let team_id = TeamId::from(Uuid::new_v4());
        let mut events = state.event_bus.subscribe();

        state
            .blackboard
            .register_stream_session(
                "session-a".to_owned(),
                team_id,
                "device-a".to_owned(),
                "connection-a".to_owned(),
            )
            .expect("stream session should register");
        state
            .blackboard
            .set_display(BlackboardDisplay {
                mode: BlackboardDisplayMode::Stream,
                selected_submission_id: None,
                selected_stream_session_id: Some("session-a".to_owned()),
                selected_preview_run_id: None,
            })
            .expect("display should select stream");
        assert!(
            state
                .blackboard
                .disconnect_stream_session("session-a", "connection-a")
                .expect("session should disconnect")
        );

        schedule_stream_session_expiration_after(
            state.clone(),
            "session-a".to_owned(),
            "connection-a".to_owned(),
            StdDuration::ZERO,
        );

        tokio::time::timeout(StdDuration::from_secs(1), async {
            loop {
                if state
                    .blackboard
                    .stream_sessions()
                    .expect("sessions should read")
                    .is_empty()
                {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("session should expire");

        let display = state.blackboard.display().expect("display should read");
        assert_eq!(display, BlackboardDisplay::default());
        assert!(matches!(
            state.blackboard.register_stream_session(
                "session-a".to_owned(),
                team_id,
                "device-a".to_owned(),
                "connection-b".to_owned(),
            ),
            Err(StoreError::InvalidatedStreamSession)
        ));

        let event = tokio::time::timeout(StdDuration::from_secs(1), events.recv())
            .await
            .expect("expiration should publish display event")
            .expect("display event should send");
        assert!(matches!(event, AppEvent::BlackboardDisplayChanged { .. }));
    }
}
