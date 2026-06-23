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
    routes::submissions::judge_next_submission_once,
    state::{AppState, NewChallenge},
};
use serde_json::{Value, json};
use tokio::time::{Instant, timeout};
use tokio_stream::StreamExt;
use tower::ServiceExt;
use uuid::Uuid;

#[tokio::test]
async fn blackboard_reports_idle_running_and_paused_state() {
    let state = AppState::new(Config::default());
    let admin_token = issue_token(
        "admin",
        Role::Admin,
        Duration::from_secs(60),
        state.auth_secret.as_ref(),
    )
    .expect("token should issue");
    let app = router(state.clone());

    let idle_response = app
        .clone()
        .oneshot(get_request("/api/v1/blackboard/state", None).expect("request should build"))
        .await
        .expect("request should complete");
    assert_eq!(idle_response.status(), StatusCode::OK);
    let idle_body = response_json(idle_response).await;
    assert_eq!(idle_body["status"], "idle");
    assert_eq!(idle_body["queue_length"], 0);

    let team = state
        .repository
        .create_team("Team", "TEAM", None)
        .expect("team should create");
    let challenge_set = state
        .repository
        .create_challenge_set("Main", "v1", ChallengeSetStatus::Active)
        .expect("challenge set should create");
    let challenge = state
        .repository
        .create_challenge(NewChallenge {
            challenge_set_id: challenge_set.id,
            slug: "shape".to_owned(),
            title: "Shape".to_owned(),
            description: "Shape".to_owned(),
            target_image_asset_id: None,
            target_image_path: None,
            target_image_url: None,
            points: 10,
            pass_threshold: 1.0,
            enabled: true,
            order: 1,
            canvas: CanvasConfig::default(),
            judge_config: json!({}),
        })
        .expect("challenge should create");
    state
        .repository
        .create_submission(team.id, challenge.id, valid_program(), None)
        .expect("submission should create");
    state
        .repository
        .pop_next_queued_submission()
        .expect("queue should pop")
        .expect("submission should exist");

    let running_response = app
        .clone()
        .oneshot(get_request("/api/v1/blackboard/state", None).expect("request should build"))
        .await
        .expect("request should complete");
    assert_eq!(running_response.status(), StatusCode::OK);
    let running_body = response_json(running_response).await;
    assert_eq!(running_body["status"], "running");
    assert_eq!(running_body["running"].as_array().expect("array").len(), 1);

    let pause_response = app
        .clone()
        .oneshot(
            json_request(
                "POST",
                "/api/v1/admin/judge-queue/pause",
                Some(&admin_token),
                json!({}),
            )
            .expect("request should build"),
        )
        .await
        .expect("request should complete");
    assert_eq!(pause_response.status(), StatusCode::OK);

    let paused_response = app
        .oneshot(get_request("/api/v1/blackboard/state", None).expect("request should build"))
        .await
        .expect("request should complete");
    assert_eq!(paused_response.status(), StatusCode::OK);
    let paused_body = response_json(paused_response).await;
    assert_eq!(paused_body["status"], "paused");
    assert_eq!(paused_body["paused"], true);
}

#[tokio::test]
async fn blackboard_events_stream_timed_judge_steps_and_judges_one_submission_at_a_time() {
    let state = AppState::new(Config::default());
    let team = state
        .repository
        .create_team("Team", "TEAM", None)
        .expect("team should create");
    let second_team = state
        .repository
        .create_team("Second Team", "SECOND", None)
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
    .expect("second token should issue");
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
            pass_threshold: 1.0,
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
    let first_submission_id = submission_id_from_json(&first_body["submission"]["id"]);

    let second_response = app
        .clone()
        .oneshot(
            json_request(
                "POST",
                &format!("/api/v1/challenges/{}/submissions", challenge.id.as_uuid()),
                Some(&second_team_token),
                json!({ "block_program": animated_program() }),
            )
            .expect("request should build"),
        )
        .await
        .expect("request should complete");
    assert_eq!(second_response.status(), StatusCode::CREATED);
    let second_body = response_json(second_response).await;
    let second_submission_id = submission_id_from_json(&second_body["submission"]["id"]);
    assert_ne!(first_submission_id, second_submission_id);

    let started_at = Instant::now();
    let first_state = state.clone();
    let first_judge = tokio::spawn(async move {
        judge_next_submission_once(first_state)
            .await
            .expect("judge should run")
            .expect("submission should be judged")
    });
    let second_state = state.clone();
    let second_judge = tokio::spawn(async move {
        judge_next_submission_once(second_state)
            .await
            .expect("judge should run")
            .expect("submission should be judged")
    });

    let mut first_step_times = Vec::new();
    let mut first_step_playback_ms = Vec::new();
    let mut first_completed_at = None;
    let mut second_started_at = None;
    while first_completed_at.is_none() || second_started_at.is_none() {
        let event = next_sse_json(&mut event_stream, &mut event_buffer).await;
        let event_type = event["type"].as_str().expect("event type should be string");
        let submission_id = event["submission_id"].as_str();
        let now = started_at.elapsed();

        if event_type == "judging_step"
            && submission_id == Some(first_body["submission"]["id"].as_str().unwrap())
        {
            first_step_times.push(now);
            first_step_playback_ms.push(
                event["playback_ms"]
                    .as_u64()
                    .expect("playback_ms should be u64"),
            );
            if first_step_times.len() == 1 {
                let running_response = app
                    .clone()
                    .oneshot(
                        get_request("/api/v1/blackboard/state", None)
                            .expect("request should build"),
                    )
                    .await
                    .expect("request should complete");
                assert_eq!(running_response.status(), StatusCode::OK);
                let running_body = response_json(running_response).await;
                assert_eq!(running_body["status"], "running");
                assert_eq!(
                    running_body["running"][0]["id"],
                    first_body["submission"]["id"]
                );
            }
        }

        if event_type == "judging_completed"
            && submission_id == Some(first_body["submission"]["id"].as_str().unwrap())
        {
            first_completed_at = Some(now);
        }
        if event_type == "judging_started"
            && submission_id == second_body["submission"]["id"].as_str()
        {
            second_started_at = Some(now);
        }
    }

    assert!(first_step_times.len() >= 2);
    assert!(
        first_step_playback_ms
            .iter()
            .all(|playback_ms| *playback_ms == 500)
    );
    assert!(
        first_step_times[1].saturating_sub(first_step_times[0]) >= Duration::from_millis(450),
        "successive stroke events should be separated by playback time"
    );
    assert!(
        second_started_at.expect("second should start")
            >= first_completed_at.expect("first should complete"),
        "second judge must not start before the first completes"
    );

    let first_completed = first_judge.await.expect("first task should join");
    let second_completed = second_judge.await.expect("second task should join");
    assert_eq!(first_completed.id, first_submission_id);
    assert_eq!(second_completed.id, second_submission_id);
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
