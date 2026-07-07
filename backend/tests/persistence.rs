use std::{fs, path::PathBuf};

use axum::{
    Router,
    body::{Body, to_bytes},
    http::{Method, Request, StatusCode, header},
    response::Response,
};
use backend::{config::Config, router, state::AppState};
use serde_json::{Value, json};
use tower::ServiceExt;

#[tokio::test]
async fn file_persistence_survives_app_state_restart_through_http_api() {
    let data_dir = TempDataDir::new();
    let config = Config {
        data_dir: Some(data_dir.path.clone()),
        ..Config::default()
    };

    let state = AppState::new(config.clone());
    let app = router(state);
    let admin_access_token = admin_token(app.clone()).await;

    let team = json_request(
        app.clone(),
        Method::POST,
        "/api/v1/admin/teams",
        Some(&admin_access_token),
        json!({
            "name": "Persistent Team",
            "login_code": "persist"
        }),
    )
    .await;
    assert_eq!(team.status(), StatusCode::OK);
    let team = response_json(team).await;
    let team_id = team["id"].as_str().expect("team id").to_owned();

    let challenge_set = json_request(
        app.clone(),
        Method::POST,
        "/api/v1/admin/challenge-sets",
        Some(&admin_access_token),
        json!({
            "name": "Persistent Set",
            "version": "v1"
        }),
    )
    .await;
    assert_eq!(challenge_set.status(), StatusCode::CREATED);
    let challenge_set = response_json(challenge_set).await;
    let challenge_set_id = challenge_set["id"].as_str().expect("set id").to_owned();

    let challenge = json_request(
        app.clone(),
        Method::POST,
        &format!("/api/v1/admin/challenge-sets/{challenge_set_id}/challenges"),
        Some(&admin_access_token),
        json!({
            "slug": "persistent-line",
            "title": "Persistent Line",
            "description": "Draw a line that survives restart",
            "points": 50,
            "enabled": true,
            "order": 1,
            "canvas": {
                "width": 32,
                "height": 32,
                "background_color": "#ffffff"
            },
            "judge_config": {}
        }),
    )
    .await;
    assert_eq!(challenge.status(), StatusCode::CREATED);
    let challenge = response_json(challenge).await;
    let challenge_id = challenge["id"].as_str().expect("challenge id").to_owned();

    let activate = request(
        app.clone(),
        Method::POST,
        &format!("/api/v1/admin/challenge-sets/{challenge_set_id}/activate"),
        Some(&admin_access_token),
        Body::empty(),
    )
    .await;
    assert_eq!(activate.status(), StatusCode::OK);

    let team_access_token = team_token(app.clone(), "persist").await;

    let round = json_request(
        app.clone(),
        Method::POST,
        "/api/v1/admin/game/rounds",
        Some(&admin_access_token),
        json!({
            "challenge_id": challenge_id,
            "submission_seconds": 120,
            "public_votes_per_team": 3
        }),
    )
    .await;
    assert_eq!(round.status(), StatusCode::CREATED);
    let round = response_json(round).await;
    assert_eq!(round["state"]["phase"], "submission_open");

    let submission = json_request(
        app.clone(),
        Method::POST,
        "/api/v1/game/rounds/current/submissions",
        Some(&team_access_token),
        json!({ "block_program": valid_program() }),
    )
    .await;
    assert_eq!(submission.status(), StatusCode::CREATED);
    let submission = response_json(submission).await;
    assert_eq!(submission["submission"]["status"], "completed");
    let submission_id = submission["submission"]["id"]
        .as_str()
        .expect("submission id")
        .to_owned();

    let score = json_request(
        app,
        Method::POST,
        "/api/v1/admin/scores/bulk-adjust",
        Some(&admin_access_token),
        json!({
            "operation": "add",
            "team_ids": [team_id],
            "amount": 123,
            "reason": "Persistence integration test"
        }),
    )
    .await;
    assert_eq!(score.status(), StatusCode::OK);

    let restarted_state = AppState::new(config);
    let restarted_app = router(restarted_state);
    let restarted_admin_token = admin_token(restarted_app.clone()).await;
    let restarted_team_token = team_token(restarted_app.clone(), "persist").await;

    let leaderboard = request(
        restarted_app.clone(),
        Method::GET,
        "/api/v1/leaderboard",
        None,
        Body::empty(),
    )
    .await;
    assert_eq!(leaderboard.status(), StatusCode::OK);
    let leaderboard = response_json(leaderboard).await;
    assert_eq!(leaderboard["teams"][0]["team_id"], team_id);
    assert_eq!(leaderboard["teams"][0]["total_score"], 123);

    let challenges = request(
        restarted_app.clone(),
        Method::GET,
        "/api/v1/challenges",
        Some(&restarted_team_token),
        Body::empty(),
    )
    .await;
    assert_eq!(challenges.status(), StatusCode::OK);
    let challenges = response_json(challenges).await;
    assert_eq!(challenges.as_array().expect("challenge array").len(), 1);
    assert_eq!(challenges[0]["id"], challenge_id);
    assert_eq!(challenges[0]["status"], "attempted");
    assert_eq!(challenges[0]["submission_count"], 1);

    let submissions = request(
        restarted_app.clone(),
        Method::GET,
        &format!("/api/v1/challenges/{challenge_id}/submissions"),
        Some(&restarted_team_token),
        Body::empty(),
    )
    .await;
    assert_eq!(submissions.status(), StatusCode::OK);
    let submissions = response_json(submissions).await;
    assert_eq!(submissions.as_array().expect("submission array").len(), 1);
    assert_eq!(submissions[0]["id"], submission_id);
    assert_eq!(submissions[0]["status"], "completed");

    let asset = request(
        restarted_app.clone(),
        Method::GET,
        &format!("/api/v1/assets/results/{submission_id}.png"),
        None,
        Body::empty(),
    )
    .await;
    assert_eq!(asset.status(), StatusCode::OK);
    assert_eq!(
        asset
            .headers()
            .get(header::CONTENT_TYPE)
            .expect("asset content type"),
        "image/png"
    );

    let game_state = request(
        restarted_app.clone(),
        Method::GET,
        "/api/v1/game/state",
        Some(&restarted_team_token),
        Body::empty(),
    )
    .await;
    assert_eq!(game_state.status(), StatusCode::OK);
    let game_state = response_json(game_state).await;
    assert_eq!(game_state["state"]["phase"], "submission_open");
    assert_eq!(game_state["state"]["current_challenge_id"], challenge_id);
    assert!(game_state["state"]["current_round_id"].is_string());

    let challenge_sets = request(
        restarted_app,
        Method::GET,
        "/api/v1/admin/challenge-sets",
        Some(&restarted_admin_token),
        Body::empty(),
    )
    .await;
    assert_eq!(challenge_sets.status(), StatusCode::OK);
    let challenge_sets = response_json(challenge_sets).await;
    assert_eq!(challenge_sets.as_array().expect("set array").len(), 1);
    assert_eq!(challenge_sets[0]["id"], challenge_set_id);
    assert_eq!(challenge_sets[0]["status"], "active");
}

struct TempDataDir {
    path: PathBuf,
}

impl TempDataDir {
    fn new() -> Self {
        Self {
            path: std::env::temp_dir()
                .join(format!("turtle-game-persistence-{}", uuid::Uuid::new_v4())),
        }
    }
}

impl Drop for TempDataDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

async fn admin_token(app: Router) -> String {
    let response = json_request(
        app,
        Method::POST,
        "/api/v1/admin/login",
        None,
        json!({ "password": admin_password() }),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let body = response_json(response).await;
    body["access_token"]
        .as_str()
        .expect("admin login should return access token")
        .to_owned()
}

async fn team_token(app: Router, code: &str) -> String {
    let response = json_request(
        app,
        Method::POST,
        "/api/v1/team/login",
        None,
        json!({ "code": code }),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let body = response_json(response).await;
    body["access_token"]
        .as_str()
        .expect("team login should return access token")
        .to_owned()
}

async fn json_request(
    app: Router,
    method: Method,
    uri: &str,
    token: Option<&str>,
    body: Value,
) -> Response {
    let mut builder = Request::builder()
        .method(method)
        .uri(uri)
        .header(header::CONTENT_TYPE, "application/json");
    if let Some(token) = token {
        builder = builder.header(header::AUTHORIZATION, format!("Bearer {token}"));
    }

    app.oneshot(
        builder
            .body(Body::from(body.to_string()))
            .expect("request should build"),
    )
    .await
    .expect("request should complete")
}

async fn request(
    app: Router,
    method: Method,
    uri: &str,
    token: Option<&str>,
    body: Body,
) -> Response {
    let mut builder = Request::builder().method(method).uri(uri);
    if let Some(token) = token {
        builder = builder.header(header::AUTHORIZATION, format!("Bearer {token}"));
    }

    app.oneshot(builder.body(body).expect("request should build"))
        .await
        .expect("request should complete")
}

async fn response_json(response: Response) -> Value {
    let bytes = to_bytes(response.into_body(), 1024 * 1024)
        .await
        .expect("body should be readable");
    serde_json::from_slice(&bytes).expect("body should be json")
}

fn valid_program() -> Value {
    json!({
        "version": 1,
        "canvas": {
            "width": 32,
            "height": 32
        },
        "start": {
            "x": 4.0,
            "y": 4.0,
            "heading": 0.0,
            "pen_down": true,
            "stroke_color": "#000000",
            "stroke_width": 1.0
        },
        "blocks": [
            { "type": "forward", "id": "move-1", "args": { "distance": 8.0 } }
        ]
    })
}

fn admin_password() -> String {
    std::env::var("ADMIN_PASSWORD")
        .ok()
        .filter(|password| !password.is_empty())
        .unwrap_or_else(|| "admin-password".to_owned())
}
