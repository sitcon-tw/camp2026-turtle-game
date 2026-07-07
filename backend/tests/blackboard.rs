use std::time::Duration;

use axum::{
    body::{Body, to_bytes},
    http::{Request, StatusCode, header},
};
use backend::{
    auth::issue_token,
    config::Config,
    models::{CanvasConfig, ChallengeSetStatus, Role, SubmissionId},
    router,
    state::{AppState, NewChallenge},
};
use serde_json::{Value, json};
use tokio::time::timeout;
use tokio_stream::StreamExt;
use tower::ServiceExt;
use uuid::Uuid;

#[tokio::test]
async fn blackboard_reports_idle_state_without_queue_fields() {
    let state = AppState::new(Config::default());
    let app = router(state.clone());

    let idle_response = app
        .clone()
        .oneshot(get_request("/api/v1/blackboard/state", None).expect("request should build"))
        .await
        .expect("request should complete");
    assert_eq!(idle_response.status(), StatusCode::OK);
    let idle_body = response_json(idle_response).await;
    assert_eq!(idle_body["status"], "idle");
    assert!(idle_body.get("queue_length").is_none());
    assert!(idle_body.get("running").is_none());
    assert!(idle_body.get("paused").is_none());
    assert!(idle_body.get("stream_sessions").is_none());
    assert!(
        idle_body["display"]
            .get("selected_stream_session_id")
            .is_none()
    );
}

#[tokio::test]
async fn blackboard_streaming_surface_is_removed() {
    let state = AppState::new(Config::default());
    let admin_token = issue_token(
        "admin",
        Role::Admin,
        Duration::from_secs(60),
        state.auth_secret.as_ref(),
    )
    .expect("admin token should issue");
    let app = router(state.clone());

    let unauthorized = app
        .clone()
        .oneshot(get_request("/api/v1/admin/blackboard/control", None).expect("request builds"))
        .await
        .expect("request completes");
    assert_eq!(unauthorized.status(), StatusCode::UNAUTHORIZED);

    let control = app
        .clone()
        .oneshot(
            get_request("/api/v1/admin/blackboard/control", Some(&admin_token))
                .expect("request builds"),
        )
        .await
        .expect("request completes");
    assert_eq!(control.status(), StatusCode::OK);
    let control_body = response_json(control).await;
    assert_eq!(control_body["display"]["mode"], "submission");
    assert!(control_body.get("stream_sessions").is_none());
    assert!(
        control_body["display"]
            .get("selected_stream_session_id")
            .is_none()
    );

    let stream_display = app
        .clone()
        .oneshot(
            json_request(
                "POST",
                "/api/v1/admin/blackboard/display",
                Some(&admin_token),
                json!({ "mode": "stream", "stream_session_id": "session-a" }),
            )
            .expect("request builds"),
        )
        .await
        .expect("request completes");
    assert_eq!(stream_display.status(), StatusCode::UNPROCESSABLE_ENTITY);

    let public_state = app
        .clone()
        .oneshot(get_request("/api/v1/blackboard/state", None).expect("request builds"))
        .await
        .expect("request completes");
    assert_eq!(public_state.status(), StatusCode::OK);
    let public_body = response_json(public_state).await;
    assert_eq!(public_body["display"]["mode"], "submission");
    assert!(public_body.get("stream_sessions").is_none());
    assert!(
        public_body["display"]
            .get("selected_stream_session_id")
            .is_none()
    );

    let team_stream = app
        .clone()
        .oneshot(get_request("/api/v1/blackboard/stream/team", None).expect("request builds"))
        .await
        .expect("request completes");
    assert_eq!(team_stream.status(), StatusCode::NOT_FOUND);

    let public_stream = app
        .clone()
        .oneshot(get_request("/api/v1/blackboard/stream/viewer", None).expect("request builds"))
        .await
        .expect("request completes");
    assert_eq!(public_stream.status(), StatusCode::NOT_FOUND);

    let admin_stream = app
        .clone()
        .oneshot(
            get_request(
                "/api/v1/admin/blackboard/stream-sessions/session-a/viewer",
                Some(&admin_token),
            )
            .expect("request builds"),
        )
        .await
        .expect("request completes");
    assert_eq!(admin_stream.status(), StatusCode::NOT_FOUND);

    let submission_display = app
        .clone()
        .oneshot(
            json_request(
                "POST",
                "/api/v1/admin/blackboard/display",
                Some(&admin_token),
                json!({ "mode": "submission" }),
            )
            .expect("request builds"),
        )
        .await
        .expect("request completes");
    assert_eq!(submission_display.status(), StatusCode::OK);
    let submission_body = response_json(submission_display).await;
    assert_eq!(submission_body["display"]["mode"], "submission");
    assert!(
        submission_body["display"]
            .get("selected_stream_session_id")
            .is_none()
    );
}

#[tokio::test]
async fn preview_runs_are_retained_per_session_and_selectable_for_blackboard() {
    let state = AppState::new(Config::default());
    let team = state
        .repository
        .create_team("Team", "TEAM", None)
        .expect("team should create");
    let team_token = issue_token(
        team.id.as_uuid().to_string(),
        Role::Team,
        Duration::from_secs(60),
        state.auth_secret.as_ref(),
    )
    .expect("team token should issue");
    let admin_token = issue_token(
        "admin",
        Role::Admin,
        Duration::from_secs(60),
        state.auth_secret.as_ref(),
    )
    .expect("admin token should issue");
    let challenge_set = state
        .repository
        .create_challenge_set("Main", "v1", ChallengeSetStatus::Active)
        .expect("challenge set should create");
    let challenge = state
        .repository
        .create_challenge(NewChallenge {
            challenge_set_id: challenge_set.id,
            slug: "preview-shape".to_owned(),
            title: "Preview Shape".to_owned(),
            description: "Preview Shape".to_owned(),
            target_image_asset_id: None,
            target_image_path: None,
            target_image_url: None,
            points: 10,
            enabled: true,
            order: 1,
            canvas: CanvasConfig::default(),
            judge_config: json!({}),
        })
        .expect("challenge should create");
    let app = router(state.clone());

    let start_response = app
        .clone()
        .oneshot(
            json_request(
                "POST",
                "/api/v1/admin/game/rounds",
                Some(&admin_token),
                json!({
                    "challenge_id": challenge.id,
                    "submission_seconds": 120,
                    "public_votes_per_team": 3
                }),
            )
            .expect("request should build"),
        )
        .await
        .expect("request should complete");
    assert_eq!(start_response.status(), StatusCode::CREATED);

    let mut oldest_preview_id = String::new();
    let mut latest_preview_id = String::new();
    for index in 0..6 {
        let response = app
            .clone()
            .oneshot(
                preview_request(
                    "/api/v1/game/rounds/current/preview-runs",
                    &team_token,
                    "station-a",
                    "device-a",
                    json!({ "block_program": animated_program() }),
                )
                .expect("request should build"),
            )
            .await
            .expect("request should complete");
        assert_eq!(response.status(), StatusCode::OK);
        let body = response_json(response).await;
        let preview_id = body["preview_run"]["id"]
            .as_str()
            .expect("preview id should be present")
            .to_owned();
        if index == 0 {
            oldest_preview_id = preview_id.clone();
        }
        latest_preview_id = preview_id;
    }

    let second_session_response = app
        .clone()
        .oneshot(
            preview_request(
                "/api/v1/game/rounds/current/preview-runs",
                &team_token,
                "station-b",
                "device-b",
                json!({ "block_program": valid_program() }),
            )
            .expect("request should build"),
        )
        .await
        .expect("request should complete");
    assert_eq!(second_session_response.status(), StatusCode::OK);

    let public_state = app
        .clone()
        .oneshot(get_request("/api/v1/blackboard/state", None).expect("request builds"))
        .await
        .expect("request completes");
    assert_eq!(public_state.status(), StatusCode::OK);
    let public_body = response_json(public_state).await;
    let preview_sessions = public_body["preview_sessions"]
        .as_array()
        .expect("preview sessions should be an array");
    assert_eq!(preview_sessions.len(), 2);
    let station_a = preview_sessions
        .iter()
        .find(|session| session["session_id"] == "station-a")
        .expect("station-a should be present");
    let station_a_runs = station_a["runs"]
        .as_array()
        .expect("station-a runs should be an array");
    assert_eq!(station_a_runs.len(), 5);
    assert_eq!(station_a_runs[0]["id"], latest_preview_id);
    assert!(
        station_a_runs
            .iter()
            .all(|run| run["id"] != oldest_preview_id)
    );

    let display_response = app
        .clone()
        .oneshot(
            json_request(
                "POST",
                "/api/v1/admin/blackboard/display",
                Some(&admin_token),
                json!({ "mode": "preview", "preview_run_id": latest_preview_id.clone() }),
            )
            .expect("request builds"),
        )
        .await
        .expect("request completes");
    assert_eq!(display_response.status(), StatusCode::OK);
    let display_body = response_json(display_response).await;
    assert_eq!(display_body["display"]["mode"], "preview");
    assert_eq!(
        display_body["display"]["selected_preview_run_id"],
        latest_preview_id
    );

    let pruned_display_response = app
        .clone()
        .oneshot(
            json_request(
                "POST",
                "/api/v1/admin/blackboard/display",
                Some(&admin_token),
                json!({ "mode": "preview", "preview_run_id": oldest_preview_id.clone() }),
            )
            .expect("request builds"),
        )
        .await
        .expect("request completes");
    assert_eq!(pruned_display_response.status(), StatusCode::NOT_FOUND);

    let next_round_response = app
        .clone()
        .oneshot(
            json_request(
                "POST",
                "/api/v1/admin/game/rounds",
                Some(&admin_token),
                json!({
                    "challenge_id": challenge.id,
                    "submission_seconds": 120,
                    "public_votes_per_team": 3
                }),
            )
            .expect("request should build"),
        )
        .await
        .expect("request should complete");
    assert_eq!(next_round_response.status(), StatusCode::CREATED);

    let cleared_state = app
        .oneshot(get_request("/api/v1/blackboard/state", None).expect("request builds"))
        .await
        .expect("request completes");
    assert_eq!(cleared_state.status(), StatusCode::OK);
    let cleared_body = response_json(cleared_state).await;
    assert!(
        cleared_body["preview_sessions"]
            .as_array()
            .expect("preview sessions should be an array")
            .is_empty()
    );
    assert_eq!(cleared_body["display"]["mode"], "submission");
}

#[tokio::test]
async fn blackboard_events_stream_immediate_judge_steps() {
    let state = AppState::new(Config::default());
    let team = state
        .repository
        .create_team("Team", "TEAM", None)
        .expect("team should create");
    let team_token = issue_token(
        team.id.as_uuid().to_string(),
        Role::Team,
        Duration::from_secs(60),
        state.auth_secret.as_ref(),
    )
    .expect("token should issue");
    let challenge_set = state
        .repository
        .create_challenge_set("Main", "v1", ChallengeSetStatus::Active)
        .expect("challenge set should create");
    let challenge = state
        .repository
        .create_challenge(NewChallenge {
            challenge_set_id: challenge_set.id,
            slug: "timed-shape".to_owned(),
            title: "Timed Shape".to_owned(),
            description: "Timed Shape".to_owned(),
            target_image_asset_id: None,
            target_image_path: None,
            target_image_url: None,
            points: 10,
            enabled: true,
            order: 1,
            canvas: CanvasConfig::default(),
            judge_config: json!({}),
        })
        .expect("challenge should create");
    let app = router(state.clone());

    let events_response = app
        .clone()
        .oneshot(get_request("/api/v1/blackboard/events", None).expect("request should build"))
        .await
        .expect("request should complete");
    assert_eq!(events_response.status(), StatusCode::OK);
    let mut event_stream = events_response.into_body().into_data_stream();
    let mut event_buffer = String::new();

    let first_response = app
        .clone()
        .oneshot(
            json_request(
                "POST",
                &format!("/api/v1/challenges/{}/submissions", challenge.id.as_uuid()),
                Some(&team_token),
                json!({ "block_program": animated_program() }),
            )
            .expect("request should build"),
        )
        .await
        .expect("request should complete");
    assert_eq!(first_response.status(), StatusCode::CREATED);
    let first_body = response_json(first_response).await;
    assert_eq!(first_body["submission"]["status"], "completed");

    let mut saw_started = false;
    let mut step_count = 0;
    let mut first_step_playback_ms = Vec::new();
    let mut saw_completed = false;
    while !saw_completed {
        let event = next_sse_json(&mut event_stream, &mut event_buffer).await;
        let event_type = event["type"].as_str().expect("event type should be string");
        let submission_id = event["submission_id"].as_str();

        if submission_id != first_body["submission"]["id"].as_str() {
            continue;
        }

        if event_type == "judging_step" {
            step_count += 1;
            first_step_playback_ms.push(
                event["playback_ms"]
                    .as_u64()
                    .expect("playback_ms should be u64"),
            );
        }

        if event_type == "judging_started" {
            saw_started = true;
        }
        if event_type == "judging_completed" {
            saw_completed = true;
        }
    }

    assert!(saw_started);
    assert!(step_count >= 2);
    assert!(
        first_step_playback_ms
            .iter()
            .all(|playback_ms| *playback_ms == 500)
    );
}

#[tokio::test]
async fn admin_playback_selection_is_single_replacement_and_clearable() {
    let state = AppState::new(Config::default());
    let team = state
        .repository
        .create_team("Team", "TEAM", None)
        .expect("team should create");
    let second_team = state
        .repository
        .create_team("Second Team", "TEAM2", None)
        .expect("second team should create");
    let team_token = issue_token(
        team.id.as_uuid().to_string(),
        Role::Team,
        Duration::from_secs(60),
        state.auth_secret.as_ref(),
    )
    .expect("token should issue");
    let second_team_token = issue_token(
        second_team.id.as_uuid().to_string(),
        Role::Team,
        Duration::from_secs(60),
        state.auth_secret.as_ref(),
    )
    .expect("second team token should issue");
    let admin_token = issue_token(
        "admin",
        Role::Admin,
        Duration::from_secs(60),
        state.auth_secret.as_ref(),
    )
    .expect("admin token should issue");
    let challenge_set = state
        .repository
        .create_challenge_set("Main", "v1", ChallengeSetStatus::Active)
        .expect("challenge set should create");
    let challenge = state
        .repository
        .create_challenge(NewChallenge {
            challenge_set_id: challenge_set.id,
            slug: "timed-shape".to_owned(),
            title: "Timed Shape".to_owned(),
            description: "Timed Shape".to_owned(),
            target_image_asset_id: None,
            target_image_path: None,
            target_image_url: None,
            points: 10,
            enabled: true,
            order: 1,
            canvas: CanvasConfig::default(),
            judge_config: json!({}),
        })
        .expect("challenge should create");
    let app = router(state.clone());

    let start_response = app
        .clone()
        .oneshot(
            json_request(
                "POST",
                "/api/v1/admin/game/rounds",
                Some(&admin_token),
                json!({
                    "challenge_id": challenge.id,
                    "submission_seconds": 120,
                    "public_votes_per_team": 3
                }),
            )
            .expect("request should build"),
        )
        .await
        .expect("request should complete");
    assert_eq!(start_response.status(), StatusCode::CREATED);

    let submission_response = app
        .clone()
        .oneshot(
            json_request(
                "POST",
                "/api/v1/game/rounds/current/submissions",
                Some(&team_token),
                json!({ "block_program": animated_program() }),
            )
            .expect("request should build"),
        )
        .await
        .expect("request should complete");
    assert_eq!(submission_response.status(), StatusCode::CREATED);
    let submission_body = response_json(submission_response).await;
    let submission_id = submission_body["submission"]["id"]
        .as_str()
        .expect("submission id should be present");
    let second_submission_response = app
        .clone()
        .oneshot(
            json_request(
                "POST",
                "/api/v1/game/rounds/current/submissions",
                Some(&second_team_token),
                json!({ "block_program": animated_program() }),
            )
            .expect("request should build"),
        )
        .await
        .expect("request should complete");
    assert_eq!(second_submission_response.status(), StatusCode::CREATED);
    let second_submission_body = response_json(second_submission_response).await;
    let second_submission_id = second_submission_body["submission"]["id"]
        .as_str()
        .expect("second submission id should be present");

    let unselected_response = app
        .clone()
        .oneshot(get_request("/api/v1/blackboard/state", None).expect("request should build"))
        .await
        .expect("request should complete");
    assert_eq!(unselected_response.status(), StatusCode::OK);
    let unselected_body = response_json(unselected_response).await;
    assert!(unselected_body["selected_submission_id"].is_null());

    let events_response = app
        .clone()
        .oneshot(get_request("/api/v1/blackboard/events", None).expect("request should build"))
        .await
        .expect("request should complete");
    assert_eq!(events_response.status(), StatusCode::OK);
    let mut event_stream = events_response.into_body().into_data_stream();
    let mut event_buffer = String::new();

    let playback_response = app
        .clone()
        .oneshot(
            json_request(
                "POST",
                &format!("/api/v1/admin/submissions/{submission_id}/blackboard-playback"),
                Some(&admin_token),
                json!({}),
            )
            .expect("request should build"),
        )
        .await
        .expect("request should complete");
    assert_eq!(playback_response.status(), StatusCode::OK);

    loop {
        let event = next_sse_json(&mut event_stream, &mut event_buffer).await;
        if event["type"] == "blackboard_playback_changed" {
            assert_eq!(event["submission_id"], submission_id);
            break;
        }
    }

    let selected_response = app
        .clone()
        .oneshot(get_request("/api/v1/blackboard/state", None).expect("request should build"))
        .await
        .expect("request should complete");
    assert_eq!(selected_response.status(), StatusCode::OK);
    let selected_body = response_json(selected_response).await;
    assert_eq!(selected_body["selected_submission_id"], submission_id);

    let replacement_response = app
        .clone()
        .oneshot(
            json_request(
                "POST",
                &format!("/api/v1/admin/submissions/{second_submission_id}/blackboard-playback"),
                Some(&admin_token),
                json!({}),
            )
            .expect("request should build"),
        )
        .await
        .expect("request should complete");
    assert_eq!(replacement_response.status(), StatusCode::OK);

    loop {
        let event = next_sse_json(&mut event_stream, &mut event_buffer).await;
        if event["type"] == "blackboard_playback_changed" {
            assert_eq!(event["submission_id"], second_submission_id);
            break;
        }
    }

    let replaced_response = app
        .clone()
        .oneshot(get_request("/api/v1/blackboard/state", None).expect("request should build"))
        .await
        .expect("request should complete");
    assert_eq!(replaced_response.status(), StatusCode::OK);
    let replaced_body = response_json(replaced_response).await;
    assert_eq!(
        replaced_body["selected_submission_id"],
        second_submission_id
    );

    let clear_response = app
        .clone()
        .oneshot(
            json_request(
                "DELETE",
                "/api/v1/admin/blackboard/playback",
                Some(&admin_token),
                json!({}),
            )
            .expect("request should build"),
        )
        .await
        .expect("request should complete");
    assert_eq!(clear_response.status(), StatusCode::OK);
    let clear_body = response_json(clear_response).await;
    assert!(clear_body["selected_submission_id"].is_null());

    loop {
        let event = next_sse_json(&mut event_stream, &mut event_buffer).await;
        if event["type"] == "blackboard_playback_changed" {
            assert!(event["submission_id"].is_null());
            break;
        }
    }

    let cleared_response = app
        .oneshot(get_request("/api/v1/blackboard/state", None).expect("request should build"))
        .await
        .expect("request should complete");
    assert_eq!(cleared_response.status(), StatusCode::OK);
    let cleared_body = response_json(cleared_response).await;
    assert!(cleared_body["selected_submission_id"].is_null());
}

fn valid_program() -> Value {
    json!({
        "version": 1,
        "canvas_width": 32,
        "canvas_height": 32,
        "start": {
            "x": 4.0,
            "y": 4.0,
            "heading_deg": 0.0,
            "pen_down": true,
            "color": "#000000",
            "stroke_width": 1.0
        },
        "blocks": []
    })
}

fn animated_program() -> Value {
    json!({
        "version": 1,
        "canvas_width": 160,
        "canvas_height": 120,
        "start": {
            "x": 10.0,
            "y": 20.0,
            "heading_deg": 0.0,
            "pen_down": true,
            "color": "#000000",
            "stroke_width": 2.0
        },
        "blocks": [
            { "type": "forward", "id": "stroke-1", "distance": 100.0 },
            { "type": "turn_right", "id": "turn-1", "degrees": 90.0 },
            { "type": "forward", "id": "stroke-2", "distance": 60.0 }
        ]
    })
}

async fn next_sse_json(stream: &mut axum::body::BodyDataStream, buffer: &mut String) -> Value {
    loop {
        if let Some(message) = take_sse_message(buffer)
            && let Some(data) = sse_data(&message)
        {
            return serde_json::from_str(&data).expect("sse data should be json");
        }

        let chunk = timeout(Duration::from_secs(3), stream.next())
            .await
            .expect("sse event should arrive")
            .expect("sse stream should remain open")
            .expect("sse chunk should be readable");
        buffer.push_str(std::str::from_utf8(&chunk).expect("sse chunk should be utf8"));
    }
}

fn take_sse_message(buffer: &mut String) -> Option<String> {
    let index = buffer.find("\n\n")?;
    let message = buffer[..index].to_owned();
    buffer.replace_range(..index + 2, "");
    Some(message)
}

fn sse_data(message: &str) -> Option<String> {
    let data = message
        .lines()
        .filter_map(|line| line.strip_prefix("data:"))
        .map(str::trim_start)
        .collect::<Vec<_>>()
        .join("\n");
    (!data.is_empty()).then_some(data)
}

fn submission_id_from_json(value: &Value) -> SubmissionId {
    value
        .as_str()
        .expect("submission id should be a string")
        .parse::<Uuid>()
        .map(SubmissionId::from)
        .expect("submission id should parse")
}

fn json_request(
    method: &str,
    uri: &str,
    token: Option<&str>,
    body: Value,
) -> Result<Request<Body>, axum::http::Error> {
    let mut builder = Request::builder()
        .method(method)
        .uri(uri)
        .header(header::CONTENT_TYPE, "application/json");
    if let Some(token) = token {
        builder = builder.header(header::AUTHORIZATION, format!("Bearer {token}"));
    }
    builder.body(Body::from(body.to_string()))
}

fn preview_request(
    uri: &str,
    token: &str,
    session_id: &str,
    device_id: &str,
    body: Value,
) -> Result<Request<Body>, axum::http::Error> {
    Request::builder()
        .method("POST")
        .uri(uri)
        .header(header::CONTENT_TYPE, "application/json")
        .header(header::AUTHORIZATION, format!("Bearer {token}"))
        .header("x-session-id", session_id)
        .header("x-device-id", device_id)
        .body(Body::from(body.to_string()))
}

fn get_request(uri: &str, token: Option<&str>) -> Result<Request<Body>, axum::http::Error> {
    let mut builder = Request::builder().method("GET").uri(uri);
    if let Some(token) = token {
        builder = builder.header(header::AUTHORIZATION, format!("Bearer {token}"));
    }
    builder.body(Body::empty())
}

async fn response_json(response: axum::response::Response) -> Value {
    let bytes = to_bytes(response.into_body(), 1024 * 1024)
        .await
        .expect("body should be readable");
    serde_json::from_slice(&bytes).expect("body should be json")
}
