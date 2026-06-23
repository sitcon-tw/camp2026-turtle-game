use std::time::Duration;

use axum::{
    body::{Body, to_bytes},
    http::{Request, StatusCode, header},
};
use backend::{
    auth::issue_token,
    config::Config,
    models::{CanvasConfig, ChallengeSetStatus, Role},
    router,
    state::{AppState, NewChallenge},
};
use serde_json::{Value, json};
use tower::ServiceExt;

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
