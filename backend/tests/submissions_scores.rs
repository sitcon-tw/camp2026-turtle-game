use std::time::Duration;

use axum::{
    body::{Body, to_bytes},
    http::{Request, StatusCode, header},
};
use backend::{
    auth::issue_token,
    config::Config,
    models::{CanvasConfig, Challenge, ChallengeSetStatus, Role, SubmissionStatus, Team},
    router,
    routes::submissions::judge_next_submission_once,
    state::{AppState, NewChallenge},
};
use serde_json::{Value, json};
use tower::ServiceExt;

#[tokio::test]
async fn submit_rejects_invalid_program_and_reports_queue_position() {
    let fixture = Fixture::new();
    let second_team = fixture
        .state
        .repository
        .create_team("Second Team", "SECOND", None)
        .expect("team should create");
    let app = router(fixture.state.clone());

    let invalid_response = app
        .clone()
        .oneshot(
            json_request(
                "POST",
                &format!(
                    "/api/v1/challenges/{}/submissions",
                    fixture.challenge.id.as_uuid()
                ),
                Some(&fixture.team_token),
                json!({ "block_program": { "bad": true } }),
            )
            .expect("request should build"),
        )
        .await
        .expect("request should complete");
    assert_eq!(invalid_response.status(), StatusCode::BAD_REQUEST);

    let first_response = app
        .clone()
        .oneshot(
            json_request(
                "POST",
                &format!(
                    "/api/v1/challenges/{}/submissions",
                    fixture.challenge.id.as_uuid()
                ),
                Some(&fixture.team_token),
                json!({ "block_program": valid_program() }),
            )
            .expect("request should build"),
        )
        .await
        .expect("request should complete");
    assert_eq!(first_response.status(), StatusCode::CREATED);
    let first_body = response_json(first_response).await;
    assert_eq!(first_body["position"], 1);

    let second_token = team_token(&fixture.state, &second_team);
    let second_response = app
        .clone()
        .oneshot(
            json_request(
                "POST",
                &format!(
                    "/api/v1/challenges/{}/submissions",
                    fixture.challenge.id.as_uuid()
                ),
                Some(&second_token),
                json!({ "block_program": valid_program() }),
            )
            .expect("request should build"),
        )
        .await
        .expect("request should complete");
    assert_eq!(second_response.status(), StatusCode::CREATED);
    let second_body = response_json(second_response).await;
    assert_eq!(second_body["position"], 2);

    let queue_response = app
        .clone()
        .oneshot(
            get_request("/api/v1/queue/me", Some(&second_token)).expect("request should build"),
        )
        .await
        .expect("request should complete");
    assert_eq!(queue_response.status(), StatusCode::OK);
    let queue_body = response_json(queue_response).await;
    assert_eq!(queue_body["paused"], false);
    assert_eq!(queue_body["running_submission"], Value::Null);
    assert_eq!(queue_body["queued_submissions"][0]["position"], 2);
    assert_eq!(
        queue_body["queued_submissions"][0]["submission"]["id"],
        second_body["submission"]["id"]
    );

    let list_response = app
        .oneshot(
            get_request(
                &format!(
                    "/api/v1/challenges/{}/submissions",
                    fixture.challenge.id.as_uuid()
                ),
                Some(&fixture.team_token),
            )
            .expect("request should build"),
        )
        .await
        .expect("request should complete");
    assert_eq!(list_response.status(), StatusCode::OK);
    let list_body = response_json(list_response).await;
    assert_eq!(list_body.as_array().expect("array response").len(), 1);
}

#[tokio::test]
async fn judge_completion_awards_points_once_and_leaderboard_reflects_score() {
    let fixture = Fixture::new();
    let first_submission = fixture
        .state
        .repository
        .create_submission(fixture.team.id, fixture.challenge.id, valid_program(), None)
        .expect("submission should create");
    let second_submission = fixture
        .state
        .repository
        .create_submission(fixture.team.id, fixture.challenge.id, valid_program(), None)
        .expect("submission should create");

    let completed = judge_next_submission_once(fixture.state.clone())
        .await
        .expect("judge should run")
        .expect("submission should be judged");
    assert_eq!(completed.id, first_submission.id);
    assert_eq!(completed.status, SubmissionStatus::Completed);
    assert_eq!(completed.passed, Some(true));
    assert_eq!(completed.awarded_points, Some(fixture.challenge.points));

    let duplicate = judge_next_submission_once(fixture.state.clone())
        .await
        .expect("judge should run")
        .expect("submission should be judged");
    assert_eq!(duplicate.id, second_submission.id);
    assert_eq!(duplicate.status, SubmissionStatus::Completed);
    assert_eq!(duplicate.passed, Some(true));
    assert_eq!(duplicate.awarded_points, Some(0));

    let team = fixture
        .state
        .repository
        .get_team(fixture.team.id)
        .expect("store should read")
        .expect("team should exist");
    assert_eq!(team.total_score, fixture.challenge.points);

    let app = router(fixture.state.clone());
    let leaderboard_response = app
        .clone()
        .oneshot(get_request("/api/v1/leaderboard", None).expect("request should build"))
        .await
        .expect("request should complete");
    assert_eq!(leaderboard_response.status(), StatusCode::OK);
    let leaderboard_body = response_json(leaderboard_response).await;
    assert!(leaderboard_body["updated_at"].is_string());
    assert_eq!(
        leaderboard_body["teams"][0]["team_id"],
        fixture.team.id.as_uuid().to_string()
    );
    assert_eq!(
        leaderboard_body["teams"][0]["total_score"],
        fixture.challenge.points
    );
    assert_eq!(leaderboard_body["teams"][0]["solved_count"], 1);
    assert!(leaderboard_body["teams"][0]["last_score_event_at"].is_string());

    let asset_response = app
        .oneshot(
            get_request(
                &format!(
                    "/api/v1/assets/results/{}.png",
                    first_submission.id.as_uuid()
                ),
                None,
            )
            .expect("request should build"),
        )
        .await
        .expect("request should complete");
    assert_eq!(asset_response.status(), StatusCode::OK);
}

#[tokio::test]
async fn submit_rejects_challenges_outside_active_set() {
    let fixture = Fixture::new();
    let archived_set = fixture
        .state
        .repository
        .create_challenge_set("Archived", "v0", ChallengeSetStatus::Archived)
        .expect("archived set should create");
    let archived_challenge = fixture
        .state
        .repository
        .create_challenge(NewChallenge {
            challenge_set_id: archived_set.id,
            slug: "archived-line".to_owned(),
            title: "Archived Line".to_owned(),
            description: "No longer live".to_owned(),
            target_image_asset_id: None,
            target_image_path: None,
            target_image_url: None,
            points: 50,
            pass_threshold: 1.0,
            enabled: true,
            order: 1,
            canvas: CanvasConfig::default(),
            judge_config: json!({}),
        })
        .expect("archived challenge should create");
    let draft_set = fixture
        .state
        .repository
        .create_challenge_set("Draft", "v2", ChallengeSetStatus::Draft)
        .expect("draft set should create");
    let draft_challenge = fixture
        .state
        .repository
        .create_challenge(NewChallenge {
            challenge_set_id: draft_set.id,
            slug: "draft-line".to_owned(),
            title: "Draft Line".to_owned(),
            description: "Not live yet".to_owned(),
            target_image_asset_id: None,
            target_image_path: None,
            target_image_url: None,
            points: 50,
            pass_threshold: 1.0,
            enabled: true,
            order: 1,
            canvas: CanvasConfig::default(),
            judge_config: json!({}),
        })
        .expect("draft challenge should create");

    let app = router(fixture.state.clone());
    for challenge in [&archived_challenge, &draft_challenge] {
        let response = app
            .clone()
            .oneshot(
                json_request(
                    "POST",
                    &format!("/api/v1/challenges/{}/submissions", challenge.id.as_uuid()),
                    Some(&fixture.team_token),
                    json!({ "block_program": valid_program() }),
                )
                .expect("request should build"),
            )
            .await
            .expect("request should complete");
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }
}

#[tokio::test]
async fn admin_bulk_score_adjustment_uses_spec_contract_and_validates_payloads() {
    let fixture = Fixture::new();
    let second_team = fixture
        .state
        .repository
        .create_team("Second Team", "SECOND", None)
        .expect("team should create");
    let app = router(fixture.state.clone());

    let add_response = app
        .clone()
        .oneshot(
            json_request(
                "POST",
                "/api/v1/admin/scores/bulk-adjust",
                Some(&fixture.admin_token),
                json!({
                    "operation": "add",
                    "team_ids": [
                        fixture.team.id.as_uuid().to_string(),
                        second_team.id.as_uuid().to_string()
                    ],
                    "amount": 20,
                    "reason": "Bonus"
                }),
            )
            .expect("request should build"),
        )
        .await
        .expect("request should complete");
    assert_eq!(add_response.status(), StatusCode::OK);
    let add_body = response_json(add_response).await;
    assert!(add_body.get("events").is_none());
    assert_eq!(
        add_body["updated_teams"].as_array().expect("array").len(),
        2
    );
    assert_eq!(
        add_body["updated_teams"][0]["team_id"],
        fixture.team.id.as_uuid().to_string()
    );
    assert_eq!(add_body["updated_teams"][0]["score_before"], 0);
    assert_eq!(add_body["updated_teams"][0]["score_after"], 20);
    assert_eq!(add_body["updated_teams"][0]["delta"], 20);
    assert!(add_body["updated_teams"][0]["score_event_id"].is_string());

    let subtract_response = app
        .clone()
        .oneshot(
            json_request(
                "POST",
                "/api/v1/admin/scores/bulk-adjust",
                Some(&fixture.admin_token),
                json!({
                    "operation": "subtract",
                    "team_ids": [fixture.team.id.as_uuid().to_string()],
                    "amount": 10,
                    "reason": "Penalty"
                }),
            )
            .expect("request should build"),
        )
        .await
        .expect("request should complete");
    assert_eq!(subtract_response.status(), StatusCode::OK);
    let subtract_body = response_json(subtract_response).await;
    assert_eq!(subtract_body["updated_teams"][0]["score_before"], 20);
    assert_eq!(subtract_body["updated_teams"][0]["score_after"], 10);
    assert_eq!(subtract_body["updated_teams"][0]["delta"], -10);

    let set_response = app
        .clone()
        .oneshot(
            json_request(
                "POST",
                "/api/v1/admin/scores/bulk-adjust",
                Some(&fixture.admin_token),
                json!({
                    "operation": "set",
                    "team_ids": [fixture.team.id.as_uuid().to_string()],
                    "target_score": 300,
                    "reason": "Manual correction"
                }),
            )
            .expect("request should build"),
        )
        .await
        .expect("request should complete");
    assert_eq!(set_response.status(), StatusCode::OK);
    let set_body = response_json(set_response).await;
    assert_eq!(set_body["updated_teams"][0]["score_before"], 10);
    assert_eq!(set_body["updated_teams"][0]["score_after"], 300);
    assert_eq!(set_body["updated_teams"][0]["delta"], 290);

    for payload in [
        json!({
            "operation": "add",
            "team_ids": [],
            "amount": 20,
            "reason": "Bonus"
        }),
        json!({
            "operation": "subtract",
            "team_ids": [fixture.team.id.as_uuid().to_string()],
            "amount": -1,
            "reason": "Penalty"
        }),
        json!({
            "operation": "set",
            "team_ids": [fixture.team.id.as_uuid().to_string()],
            "target_score": 300
        }),
    ] {
        let response = app
            .clone()
            .oneshot(
                json_request(
                    "POST",
                    "/api/v1/admin/scores/bulk-adjust",
                    Some(&fixture.admin_token),
                    payload,
                )
                .expect("request should build"),
            )
            .await
            .expect("request should complete");
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }
}

#[tokio::test]
async fn admin_can_cancel_queued_and_prioritize_queue_order() {
    let fixture = Fixture::new();
    let first = fixture
        .state
        .repository
        .create_submission(fixture.team.id, fixture.challenge.id, valid_program(), None)
        .expect("submission should create");
    let second = fixture
        .state
        .repository
        .create_submission(fixture.team.id, fixture.challenge.id, valid_program(), None)
        .expect("submission should create");
    let third = fixture
        .state
        .repository
        .create_submission(fixture.team.id, fixture.challenge.id, valid_program(), None)
        .expect("submission should create");
    let app = router(fixture.state.clone());

    let prioritize_response = app
        .clone()
        .oneshot(
            json_request(
                "POST",
                &format!(
                    "/api/v1/admin/judge-queue/{}/prioritize",
                    third.id.as_uuid()
                ),
                Some(&fixture.admin_token),
                json!({ "position": 1 }),
            )
            .expect("request should build"),
        )
        .await
        .expect("request should complete");
    assert_eq!(prioritize_response.status(), StatusCode::OK);

    let cancel_response = app
        .clone()
        .oneshot(
            json_request(
                "POST",
                &format!("/api/v1/admin/submissions/{}/cancel", second.id.as_uuid()),
                Some(&fixture.admin_token),
                json!({}),
            )
            .expect("request should build"),
        )
        .await
        .expect("request should complete");
    assert_eq!(cancel_response.status(), StatusCode::OK);
    let cancel_body = response_json(cancel_response).await;
    assert_eq!(cancel_body["status"], "cancelled");

    let queue_response = app
        .oneshot(
            get_request("/api/v1/admin/judge-queue", Some(&fixture.admin_token))
                .expect("request should build"),
        )
        .await
        .expect("request should complete");
    assert_eq!(queue_response.status(), StatusCode::OK);
    let queue_body = response_json(queue_response).await;
    assert_eq!(queue_body["queue_length"], 2);
    assert_eq!(
        queue_body["submissions"][0]["id"],
        third.id.as_uuid().to_string()
    );
    assert_eq!(
        queue_body["submissions"][1]["id"],
        first.id.as_uuid().to_string()
    );
}

struct Fixture {
    state: AppState,
    team: Team,
    challenge: Challenge,
    team_token: String,
    admin_token: String,
}

impl Fixture {
    fn new() -> Self {
        let state = AppState::new(Config::default());
        let team = state
            .repository
            .create_team("Team One", "TEAM1", None)
            .expect("team should create");
        let challenge_set = state
            .repository
            .create_challenge_set("Main", "v1", ChallengeSetStatus::Active)
            .expect("challenge set should create");
        let challenge = state
            .repository
            .create_challenge(NewChallenge {
                challenge_set_id: challenge_set.id,
                slug: "draw-line".to_owned(),
                title: "Draw Line".to_owned(),
                description: "Draw a line".to_owned(),
                target_image_asset_id: None,
                target_image_path: None,
                target_image_url: None,
                points: 50,
                pass_threshold: 1.0,
                enabled: true,
                order: 1,
                canvas: CanvasConfig::default(),
                judge_config: json!({}),
            })
            .expect("challenge should create");
        let team_token = team_token(&state, &team);
        let admin_token = issue_token(
            "admin",
            Role::Admin,
            Duration::from_secs(60),
            state.auth_secret.as_ref(),
        )
        .expect("token should issue");

        Self {
            state,
            team,
            challenge,
            team_token,
            admin_token,
        }
    }
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

fn team_token(state: &AppState, team: &Team) -> String {
    issue_token(
        team.id.as_uuid().to_string(),
        Role::Team,
        Duration::from_secs(60),
        state.auth_secret.as_ref(),
    )
    .expect("token should issue")
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
