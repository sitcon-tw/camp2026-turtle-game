use std::time::Duration;

use axum::{
    body::{Body, to_bytes},
    http::{Method, Request, StatusCode, header},
    response::Response,
};
use backend::{
    auth::issue_token,
    config::Config,
    models::{CanvasConfig, Challenge, ChallengeSetStatus, GamePhase, Role, Team},
    router,
    state::{AppState, NewChallenge},
};
use serde_json::{Value, json};
use tower::ServiceExt;

#[tokio::test]
async fn admin_controls_full_round_and_teams_vote_to_score() {
    let fixture = Fixture::new();
    let app = router(fixture.state.clone());

    let start = json_request(
        app.clone(),
        Method::POST,
        "/api/v1/admin/game/rounds",
        Some(&fixture.admin_token),
        json!({
            "challenge_id": fixture.challenge.id,
            "submission_seconds": 120,
            "public_votes_per_team": 3
        }),
    )
    .await;
    assert_eq!(start.status(), StatusCode::CREATED);
    let start_body = response_json(start).await;
    assert_eq!(start_body["state"]["phase"], "submission_open");
    assert_eq!(start_body["state"]["version"], 1);

    let mut submission_ids = Vec::new();
    for (index, team) in fixture.teams.iter().enumerate() {
        let token = team_token(&fixture.state, team);
        let response = json_request(
            app.clone(),
            Method::POST,
            "/api/v1/game/rounds/current/submissions",
            Some(&token),
            json!({ "block_program": { "team": index } }),
        )
        .await;
        assert_eq!(response.status(), StatusCode::CREATED);
        let body = response_json(response).await;
        submission_ids.push(body["submission"]["id"].clone());
    }

    let phase = json_request(
        app.clone(),
        Method::POST,
        "/api/v1/admin/game/phase",
        Some(&fixture.admin_token),
        json!({ "phase": GamePhase::TeamSelection }),
    )
    .await;
    assert_eq!(phase.status(), StatusCode::OK);
    let phase_body = response_json(phase).await;
    assert_eq!(phase_body["state"]["phase"], "team_selection");
    assert!(phase_body["state"]["phase_ends_at"].is_string());

    for (index, team) in fixture.teams.iter().enumerate() {
        let token = team_token(&fixture.state, team);
        let response = json_request_with_device(
            app.clone(),
            Method::POST,
            "/api/v1/game/rounds/current/team-selection-votes",
            Some(&token),
            Some(&format!("device-{index}")),
            json!({ "submission_id": submission_ids[index] }),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
    }

    let phase = json_request(
        app.clone(),
        Method::POST,
        "/api/v1/admin/game/phase",
        Some(&fixture.admin_token),
        json!({ "phase": GamePhase::PublicVoting }),
    )
    .await;
    assert_eq!(phase.status(), StatusCode::OK);
    let public_body = response_json(phase).await;
    assert_eq!(
        public_body["nominations"]
            .as_array()
            .expect("nominations")
            .len(),
        3
    );

    let team_votes = [
        vec![(1, 1), (2, 2)],
        vec![(0, 1), (2, 2)],
        vec![(0, 1), (1, 2)],
    ];
    for (voter_index, votes) in team_votes.iter().enumerate() {
        let token = team_token(&fixture.state, &fixture.teams[voter_index]);
        let payload_votes: Vec<_> = votes
            .iter()
            .map(|(target_index, rank)| {
                json!({
                    "target_team_id": fixture.teams[*target_index].id,
                    "target_submission_id": submission_ids[*target_index],
                    "rank": rank
                })
            })
            .collect();
        let response = json_request(
            app.clone(),
            Method::POST,
            "/api/v1/game/rounds/current/public-votes",
            Some(&token),
            json!({ "votes": payload_votes }),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
    }

    let scored = json_request(
        app.clone(),
        Method::POST,
        "/api/v1/admin/game/score",
        Some(&fixture.admin_token),
        json!({}),
    )
    .await;
    assert_eq!(scored.status(), StatusCode::OK);
    let scored_body = response_json(scored).await;
    assert_eq!(scored_body["state"]["phase"], "round_complete");
    let results = scored_body["results"].as_array().expect("results");
    assert_eq!(results.len(), 3);
    assert_eq!(results[0]["placement_points"], 100);
    assert_eq!(results[1]["placement_points"], 70);
    assert_eq!(results[2]["placement_points"], 50);

    let leaderboard = get_request(app, "/api/v1/leaderboard", None).await;
    assert_eq!(leaderboard.status(), StatusCode::OK);
    let leaderboard_body = response_json(leaderboard).await;
    assert_eq!(
        leaderboard_body["teams"].as_array().expect("teams").len(),
        3
    );
}

#[tokio::test]
async fn game_rejects_actions_outside_their_phase_and_invalid_public_votes() {
    let fixture = Fixture::new();
    let app = router(fixture.state.clone());
    let team_token = team_token(&fixture.state, &fixture.teams[0]);

    let early_submit = json_request(
        app.clone(),
        Method::POST,
        "/api/v1/game/rounds/current/submissions",
        Some(&team_token),
        json!({ "block_program": {} }),
    )
    .await;
    assert_eq!(early_submit.status(), StatusCode::BAD_REQUEST);

    let start = json_request(
        app.clone(),
        Method::POST,
        "/api/v1/admin/game/rounds",
        Some(&fixture.admin_token),
        json!({ "challenge_id": fixture.challenge.id, "submission_seconds": 1 }),
    )
    .await;
    assert_eq!(start.status(), StatusCode::CREATED);

    let vote_too_early = json_request_with_device(
        app.clone(),
        Method::POST,
        "/api/v1/game/rounds/current/team-selection-votes",
        Some(&team_token),
        Some("device-a"),
        json!({ "submission_id": "00000000-0000-0000-0000-000000000000" }),
    )
    .await;
    assert_eq!(vote_too_early.status(), StatusCode::NOT_FOUND);

    let timer = json_request(
        app.clone(),
        Method::PATCH,
        "/api/v1/admin/game/timer",
        Some(&fixture.admin_token),
        json!({ "add_seconds": 30 }),
    )
    .await;
    assert_eq!(timer.status(), StatusCode::OK);
}

struct Fixture {
    state: AppState,
    admin_token: String,
    teams: Vec<Team>,
    challenge: Challenge,
}

impl Fixture {
    fn new() -> Self {
        let state = AppState::new(Config::default());
        let teams = vec![
            state
                .repository
                .create_team("Alpha", "ALPHA", None)
                .expect("team creates"),
            state
                .repository
                .create_team("Beta", "BETA", None)
                .expect("team creates"),
            state
                .repository
                .create_team("Gamma", "GAMMA", None)
                .expect("team creates"),
        ];
        let challenge_set = state
            .repository
            .create_challenge_set("Set", "v1", ChallengeSetStatus::Active)
            .expect("set creates");
        let challenge = state
            .repository
            .create_challenge(NewChallenge {
                challenge_set_id: challenge_set.id,
                slug: "draw-a-turtle".to_owned(),
                title: "Draw a turtle".to_owned(),
                description: "Make the best turtle".to_owned(),
                target_image_asset_id: None,
                target_image_path: None,
                target_image_url: None,
                points: 100,
                pass_threshold: 0.9,
                enabled: true,
                order: 1,
                canvas: CanvasConfig::default(),
                judge_config: json!({}),
            })
            .expect("challenge creates");
        let admin_token = issue_token(
            "admin",
            Role::Admin,
            Duration::from_secs(3600),
            &state.auth_secret,
        )
        .expect("admin token");
        Self {
            state,
            admin_token,
            teams,
            challenge,
        }
    }
}

fn team_token(state: &AppState, team: &Team) -> String {
    issue_token(
        team.id.as_uuid().to_string(),
        Role::Team,
        Duration::from_secs(3600),
        &state.auth_secret,
    )
    .expect("team token")
}

async fn get_request(app: axum::Router, path: &str, token: Option<&str>) -> Response {
    let mut builder = Request::builder().method(Method::GET).uri(path);
    if let Some(token) = token {
        builder = builder.header(header::AUTHORIZATION, format!("Bearer {token}"));
    }
    app.oneshot(builder.body(Body::empty()).expect("request builds"))
        .await
        .expect("request completes")
}

async fn json_request(
    app: axum::Router,
    method: Method,
    path: &str,
    token: Option<&str>,
    body: Value,
) -> Response {
    json_request_with_device(app, method, path, token, None, body).await
}

async fn json_request_with_device(
    app: axum::Router,
    method: Method,
    path: &str,
    token: Option<&str>,
    device_id: Option<&str>,
    body: Value,
) -> Response {
    let mut builder = Request::builder()
        .method(method)
        .uri(path)
        .header(header::CONTENT_TYPE, "application/json");
    if let Some(token) = token {
        builder = builder.header(header::AUTHORIZATION, format!("Bearer {token}"));
    }
    if let Some(device_id) = device_id {
        builder = builder.header("x-device-id", device_id);
    }
    app.oneshot(
        builder
            .body(Body::from(body.to_string()))
            .expect("request builds"),
    )
    .await
    .expect("request completes")
}

async fn response_json(response: Response) -> Value {
    let bytes = to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("body reads");
    serde_json::from_slice(&bytes).expect("body is json")
}
