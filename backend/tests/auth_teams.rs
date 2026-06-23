use axum::{
    Router,
    body::{Body, to_bytes},
    http::{Method, Request, StatusCode, header},
    response::Response,
};
use backend::{config::Config, models::TeamId, router, state::AppState};
use serde_json::{Value, json};
use tower::ServiceExt;
use uuid::Uuid;

#[tokio::test]
async fn team_login_accepts_valid_code_and_rejects_invalid_or_disabled_teams() {
    let state = AppState::new(Config::default());
    let team = state
        .repository
        .create_team("Turtles", "ABC123", None)
        .expect("team should create");
    let disabled = state
        .repository
        .create_team("Disabled", "ZZ9999", None)
        .expect("disabled team should create");
    state
        .repository
        .set_team_enabled(disabled.id, false)
        .expect("team should disable");
    let app = router(state);

    let response = json_request(
        app.clone(),
        Method::POST,
        "/api/v1/team/login",
        None,
        json!({ "code": "abc123" }),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let body = response_json(response).await;
    assert_eq!(body["role"], "team");
    assert_eq!(body["subject"], team.id.as_uuid().to_string());
    assert_eq!(body["team"]["id"], team.id.as_uuid().to_string());
    assert!(body["team"]["login_code"].is_null());
    assert!(
        body["access_token"]
            .as_str()
            .is_some_and(|token| !token.is_empty())
    );

    let response = json_request(
        app.clone(),
        Method::POST,
        "/api/v1/team/login",
        None,
        json!({ "code": "missing" }),
    )
    .await;
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    let body = response_json(response).await;
    assert_eq!(body["error"]["code"], "invalid_team_code");

    let response = json_request(
        app,
        Method::POST,
        "/api/v1/team/login",
        None,
        json!({ "code": "ZZ9999" }),
    )
    .await;
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    let body = response_json(response).await;
    assert_eq!(body["error"]["code"], "team_disabled");
}

#[tokio::test]
async fn me_requires_team_token_and_returns_current_team() {
    let state = AppState::new(Config::default());
    let team = state
        .repository
        .create_team("Team Me", "ME1234", Some("visible".to_owned()))
        .expect("team should create");
    let app = router(state);

    let team_token = team_token(app.clone(), "ME1234").await;
    let response = json_request(
        app.clone(),
        Method::GET,
        "/api/v1/me",
        Some(&team_token),
        Value::Null,
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let body = response_json(response).await;
    assert_eq!(body["id"], team.id.as_uuid().to_string());
    assert_eq!(body["name"], "Team Me");
    assert_eq!(body["note"], "visible");
    assert!(body["login_code"].is_null());

    let admin_token = admin_token(app.clone()).await;
    let response = json_request(
        app,
        Method::GET,
        "/api/v1/me",
        Some(&admin_token),
        Value::Null,
    )
    .await;
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    let body = response_json(response).await;
    assert_eq!(body["error"]["code"], "team_auth_required");
}

#[tokio::test]
async fn team_token_is_forbidden_for_admin_context() {
    let state = AppState::new(Config::default());
    state
        .repository
        .create_team("Team", "TEAM42", None)
        .expect("team should create");
    let app = router(state);
    let team_token = team_token(app.clone(), "TEAM42").await;

    let response = json_request(
        app,
        Method::GET,
        "/api/v1/admin/me",
        Some(&team_token),
        Value::Null,
    )
    .await;
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    let body = response_json(response).await;
    assert_eq!(body["error"]["code"], "admin_auth_required");
}

#[tokio::test]
async fn admin_login_accepts_configured_password_and_rejects_wrong_password() {
    let app = router(AppState::new(Config::default()));

    let response = json_request(
        app.clone(),
        Method::POST,
        "/api/v1/admin/login",
        None,
        json!({ "password": "wrong" }),
    )
    .await;
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    let body = response_json(response).await;
    assert_eq!(body["error"]["code"], "invalid_admin_password");

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
    assert_eq!(body["role"], "admin");
    assert_eq!(body["subject"], "admin");
    assert!(
        body["access_token"]
            .as_str()
            .is_some_and(|token| !token.is_empty())
    );
}

#[tokio::test]
async fn admin_can_create_list_get_update_rotate_delete_and_bulk_create_teams() {
    let app = router(AppState::new(Config::default()));
    let admin_token = admin_token(app.clone()).await;

    let created = create_team(
        app.clone(),
        &admin_token,
        json!({ "name": "Alpha", "note": "first" }),
    )
    .await;
    assert_eq!(created["name"], "Alpha");
    let generated_code = created["login_code"]
        .as_str()
        .expect("login code should be a string")
        .to_owned();
    assert_eq!(generated_code.len(), 6);

    let manual = create_team(
        app.clone(),
        &admin_token,
        json!({ "name": "Beta", "login_code": "beta42" }),
    )
    .await;
    assert_eq!(manual["login_code"], "BETA42");

    let response = json_request(
        app.clone(),
        Method::GET,
        "/api/v1/admin/teams?enabled=true&search=alp",
        Some(&admin_token),
        Value::Null,
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let listed = response_json(response).await;
    assert_eq!(listed.as_array().expect("list should be an array").len(), 1);
    assert_eq!(listed[0]["name"], "Alpha");

    let created_id = parse_team_id(&created);
    let response = json_request(
        app.clone(),
        Method::GET,
        &format!("/api/v1/admin/teams/{}", created_id.as_uuid()),
        Some(&admin_token),
        Value::Null,
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let details = response_json(response).await;
    assert_eq!(details["team"]["id"], created_id.as_uuid().to_string());
    assert_eq!(
        details["challenge_statuses"]
            .as_array()
            .expect("challenge statuses should be an array")
            .len(),
        0
    );
    assert_eq!(
        details["recent_submissions"]
            .as_array()
            .expect("recent submissions should be an array")
            .len(),
        0
    );
    assert_eq!(
        details["recent_score_events"]
            .as_array()
            .expect("recent score events should be an array")
            .len(),
        0
    );

    let response = json_request(
        app.clone(),
        Method::PATCH,
        &format!("/api/v1/admin/teams/{}", created_id.as_uuid()),
        Some(&admin_token),
        json!({
            "name": "Alpha Updated",
            "login_code": "new777",
            "enabled": false,
            "note": null
        }),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let updated = response_json(response).await;
    assert_eq!(updated["name"], "Alpha Updated");
    assert_eq!(updated["login_code"], "NEW777");
    assert_eq!(updated["enabled"], false);
    assert!(updated["note"].is_null());

    let response = json_request(
        app.clone(),
        Method::PATCH,
        &format!("/api/v1/admin/teams/{}", created_id.as_uuid()),
        Some(&admin_token),
        json!({ "login_code": "BETA42" }),
    )
    .await;
    assert_eq!(response.status(), StatusCode::CONFLICT);
    let body = response_json(response).await;
    assert_eq!(body["error"]["code"], "duplicate_login_code");

    let response = json_request(
        app.clone(),
        Method::POST,
        &format!("/api/v1/admin/teams/{}/rotate-code", created_id.as_uuid()),
        Some(&admin_token),
        Value::Null,
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let rotated = response_json(response).await;
    let rotated_code = rotated["login_code"]
        .as_str()
        .expect("rotated login code should be a string");
    assert_eq!(rotated_code.len(), 6);
    assert_ne!(rotated_code, "NEW777");
    assert_eq!(rotated["team"]["login_code"], rotated["login_code"]);

    let response = json_request(
        app.clone(),
        Method::DELETE,
        &format!("/api/v1/admin/teams/{}", created_id.as_uuid()),
        Some(&admin_token),
        Value::Null,
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let deleted = response_json(response).await;
    assert_eq!(deleted["disabled"], true);
    assert_eq!(deleted["team"]["enabled"], false);

    let response = json_request(
        app,
        Method::POST,
        "/api/v1/admin/teams/bulk-create",
        Some(&admin_token),
        json!({
            "teams": [
                { "name": "Gamma", "login_code": "GAMMA1" },
                { "name": "Delta" }
            ]
        }),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let bulk = response_json(response).await;
    assert_eq!(
        bulk["teams"]
            .as_array()
            .expect("teams should be an array")
            .len(),
        2
    );
    assert_eq!(bulk["teams"][0]["login_code"], "GAMMA1");
    assert_eq!(
        bulk["teams"][1]["login_code"]
            .as_str()
            .expect("generated code should be a string")
            .len(),
        6
    );
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

async fn create_team(app: Router, token: &str, body: Value) -> Value {
    let response = json_request(app, Method::POST, "/api/v1/admin/teams", Some(token), body).await;
    assert_eq!(response.status(), StatusCode::OK);
    response_json(response).await
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

    let body = if body.is_null() {
        Body::empty()
    } else {
        Body::from(serde_json::to_vec(&body).expect("request body should serialize"))
    };

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

fn parse_team_id(team: &Value) -> TeamId {
    let id = team["id"].as_str().expect("team id should be a string");
    TeamId::from(id.parse::<Uuid>().expect("team id should be a uuid"))
}

fn admin_password() -> String {
    std::env::var("ADMIN_PASSWORD")
        .ok()
        .filter(|password| !password.is_empty())
        .unwrap_or_else(|| "admin-password".to_owned())
}
