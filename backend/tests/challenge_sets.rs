use std::io::{Cursor, Read, Write};

use axum::{
    Router,
    body::{Body, to_bytes},
    http::{Method, Request, StatusCode, header},
    response::Response,
};
use backend::{
    auth::issue_token,
    config::Config,
    models::{CanvasConfig, ChallengeSetStatus, Role},
    router,
    state::{AppState, CompletedSubmission, NewChallenge},
};
use serde_json::{Value, json};
use tower::ServiceExt;
use zip::{
    ZipWriter,
    write::{FileOptions, SimpleFileOptions},
};

const PNG_BYTES: &[u8] = b"\x89PNG\r\n\x1a\nminimal";
const VALID_PNG_BYTES: &[u8] = &[
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
    0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
    0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
    0x42, 0x60, 0x82,
];

#[tokio::test]
async fn team_challenge_list_uses_active_enabled_challenges_and_progress() {
    let state = AppState::new(Config::default());
    let team = state
        .repository
        .create_team("Team", "TEAM01", None)
        .expect("team should create");
    let challenge_set = state
        .repository
        .create_challenge_set("Set", "v1", ChallengeSetStatus::Active)
        .expect("set should create");
    let enabled = state
        .repository
        .create_challenge(NewChallenge {
            challenge_set_id: challenge_set.id,
            slug: "draw-square".to_owned(),
            title: "Draw Square".to_owned(),
            description: "Use four lines".to_owned(),
            target_image_asset_id: None,
            target_image_path: None,
            target_image_url: None,
            points: 100,
            enabled: true,
            order: 1,
            canvas: CanvasConfig::default(),
            judge_config: json!({}),
        })
        .expect("enabled challenge should create");
    let disabled = state
        .repository
        .create_challenge(NewChallenge {
            challenge_set_id: challenge_set.id,
            slug: "hidden".to_owned(),
            title: "Hidden".to_owned(),
            description: "Disabled".to_owned(),
            target_image_asset_id: None,
            target_image_path: None,
            target_image_url: None,
            points: 50,
            enabled: false,
            order: 2,
            canvas: CanvasConfig::default(),
            judge_config: json!({}),
        })
        .expect("disabled challenge should create");
    let submission = state
        .repository
        .create_submission(team.id, enabled.id, json!({ "blocks": [] }), None)
        .expect("submission should create");
    state
        .repository
        .mark_submission_completed(
            submission.id,
            CompletedSubmission {
                trace: None,
                result_image_asset_id: None,
                result_image_path: None,
                result_image_url: None,
            },
        )
        .expect("submission should complete");
    let token = token_for(&state, team.id.as_uuid().to_string(), Role::Team);
    let app = router(state);

    let response = request(
        app.clone(),
        Method::GET,
        "/api/v1/challenges",
        Some(&token),
        Body::empty(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let body = response_json(response).await;
    let challenges = body.as_array().expect("challenges should be an array");
    assert_eq!(challenges.len(), 1);
    assert_eq!(challenges[0]["id"], enabled.id.as_uuid().to_string());
    assert_eq!(challenges[0]["status"], "attempted");
    assert_eq!(challenges[0]["submission_count"], 1);

    let response = request(
        app,
        Method::GET,
        &format!("/api/v1/challenges/{}", disabled.id.as_uuid()),
        Some(&token),
        Body::empty(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn admin_imports_valid_zip_as_draft_challenge_set() {
    let state = AppState::new(Config::default());
    let admin_token = token_for(&state, "admin", Role::Admin);
    let app = router(state);
    let zip = valid_import_zip();

    let response = multipart_request(
        app.clone(),
        "/api/v1/admin/challenge-sets/import",
        &admin_token,
        zip,
    )
    .await;
    assert_eq!(response.status(), StatusCode::CREATED);
    let body = response_json(response).await;
    assert_eq!(body["name"], "Imported Set");
    assert_eq!(body["version"], "v1");
    assert_eq!(body["status"], "draft");
    assert_eq!(body["challenge_count"], 2);
    let set_id = body["id"]
        .as_str()
        .expect("imported set id should be a string")
        .to_owned();

    let response = request(
        app.clone(),
        Method::GET,
        "/api/v1/admin/challenge-sets",
        Some(&admin_token),
        Body::empty(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let body = response_json(response).await;
    assert_eq!(
        body.as_array()
            .expect("challenge sets should be an array")
            .len(),
        1
    );

    let response = request(
        app,
        Method::GET,
        &format!("/api/v1/admin/challenge-sets/{set_id}/export"),
        Some(&admin_token),
        Body::empty(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response
            .headers()
            .get(header::CONTENT_TYPE)
            .expect("content-type should be set"),
        "application/zip"
    );
    let bytes = response_bytes(response).await;
    let mut archive = zip::ZipArchive::new(Cursor::new(bytes)).expect("export should be a zip");
    let mut manifest = String::new();
    archive
        .by_name("manifest.json")
        .expect("manifest should exist")
        .read_to_string(&mut manifest)
        .expect("manifest should read");
    assert!(manifest.contains("Imported Set"));
    assert!(archive.by_name("images/one.png").is_ok());
    assert!(archive.by_name("images/two.png").is_ok());
}

#[tokio::test]
async fn admin_import_rejects_missing_manifest_duplicate_slug_and_path_traversal() {
    let state = AppState::new(Config::default());
    let admin_token = token_for(&state, "admin", Role::Admin);
    let app = router(state);

    let response = multipart_request(
        app.clone(),
        "/api/v1/admin/challenge-sets/import",
        &admin_token,
        zip_with_entries(vec![("images/target.png", VALID_PNG_BYTES.to_vec())]),
    )
    .await;
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let body = response_json(response).await;
    assert!(
        body["error"]["message"]
            .as_str()
            .expect("error should have a message")
            .contains("manifest")
    );

    let response = multipart_request(
        app.clone(),
        "/api/v1/admin/challenge-sets/import",
        &admin_token,
        duplicate_slug_zip(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let body = response_json(response).await;
    assert!(
        body["error"]["message"]
            .as_str()
            .expect("error should have a message")
            .contains("duplicate challenge slug")
    );

    let response = multipart_request(
        app.clone(),
        "/api/v1/admin/challenge-sets/import",
        &admin_token,
        zip_with_entries(vec![
            ("manifest.json", manifest_bytes("images/target.png")),
            ("../target.png", VALID_PNG_BYTES.to_vec()),
            ("images/target.png", VALID_PNG_BYTES.to_vec()),
        ]),
    )
    .await;
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let body = response_json(response).await;
    assert!(
        body["error"]["message"]
            .as_str()
            .expect("error should have a message")
            .contains("unsafe")
    );

    let response = multipart_request(
        app,
        "/api/v1/admin/challenge-sets/import",
        &admin_token,
        zip_with_entries(vec![
            ("manifest.json", manifest_bytes("images/target.png")),
            ("images/target.png", PNG_BYTES.to_vec()),
        ]),
    )
    .await;
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let body = response_json(response).await;
    assert!(
        body["error"]["message"]
            .as_str()
            .expect("error should have a message")
            .contains("image is invalid")
    );
}

#[tokio::test]
async fn admin_can_create_challenge_set_challenge_upload_image_and_export_zip() {
    let state = AppState::new(Config::default());
    let team = state
        .repository
        .create_team("Api Team", "API001", None)
        .expect("team should create");
    let admin_token = token_for(&state, "admin", Role::Admin);
    let team_token = token_for(&state, team.id.as_uuid().to_string(), Role::Team);
    let app = router(state);

    let create_set_response = json_request(
        app.clone(),
        Method::POST,
        "/api/v1/admin/challenge-sets",
        Some(&admin_token),
        json!({ "name": "Manual Set", "version": "v1" }),
    )
    .await;
    assert_eq!(create_set_response.status(), StatusCode::CREATED);
    let created_set = response_json(create_set_response).await;
    assert_eq!(created_set["name"], "Manual Set");
    assert_eq!(created_set["status"], "draft");
    assert_eq!(created_set["challenge_count"], 0);
    let set_id = created_set["id"]
        .as_str()
        .expect("set id should be a string")
        .to_owned();

    let create_challenge_response = json_request(
        app.clone(),
        Method::POST,
        &format!("/api/v1/admin/challenge-sets/{set_id}/challenges"),
        Some(&admin_token),
        json!({
            "slug": "manual-line",
            "title": "Manual Line",
            "description": "Created through JSON API",
            "points": 75,
            "enabled": true,
            "order": 3,
            "canvas": {
                "width": 32,
                "height": 32,
                "background_color": "#ffffff"
            },
            "judge_config": { "mode": "pixel" }
        }),
    )
    .await;
    assert_eq!(create_challenge_response.status(), StatusCode::CREATED);
    let created_challenge = response_json(create_challenge_response).await;
    assert_eq!(created_challenge["slug"], "manual-line");
    assert_eq!(created_challenge["stats"]["submission_count"], 0);
    assert!(created_challenge["target_image_asset_id"].is_null());
    let challenge_id = created_challenge["id"]
        .as_str()
        .expect("challenge id should be a string")
        .to_owned();

    let duplicate_response = json_request(
        app.clone(),
        Method::POST,
        &format!("/api/v1/admin/challenge-sets/{set_id}/challenges"),
        Some(&admin_token),
        json!({
            "slug": "manual-line",
            "title": "Duplicate",
            "points": 75
        }),
    )
    .await;
    assert_eq!(duplicate_response.status(), StatusCode::BAD_REQUEST);

    let upload_response = multipart_request_with_content_type(
        app.clone(),
        &format!("/api/v1/admin/challenges/{challenge_id}/target-image"),
        &admin_token,
        "target.png",
        "image/png",
        VALID_PNG_BYTES.to_vec(),
    )
    .await;
    assert_eq!(upload_response.status(), StatusCode::OK);
    let uploaded = response_json(upload_response).await;
    assert!(uploaded["target_image_asset_id"].is_string());
    assert_eq!(uploaded["target_image_path"], "images/target.png");

    let invalid_upload_response = multipart_request_with_content_type(
        app.clone(),
        &format!("/api/v1/admin/challenges/{challenge_id}/target-image"),
        &admin_token,
        "broken.png",
        "image/png",
        PNG_BYTES.to_vec(),
    )
    .await;
    assert_eq!(invalid_upload_response.status(), StatusCode::BAD_REQUEST);
    let invalid_upload = response_json(invalid_upload_response).await;
    assert_eq!(
        invalid_upload["error"]["message"],
        "target image is invalid"
    );

    let activate_response = request(
        app.clone(),
        Method::POST,
        &format!("/api/v1/admin/challenge-sets/{set_id}/activate"),
        Some(&admin_token),
        Body::empty(),
    )
    .await;
    assert_eq!(activate_response.status(), StatusCode::OK);

    let team_challenges_response = request(
        app.clone(),
        Method::GET,
        "/api/v1/challenges",
        Some(&team_token),
        Body::empty(),
    )
    .await;
    assert_eq!(team_challenges_response.status(), StatusCode::OK);
    let team_challenges = response_json(team_challenges_response).await;
    assert_eq!(team_challenges.as_array().expect("array").len(), 1);
    assert_eq!(team_challenges[0]["id"], challenge_id);

    let export_response = request(
        app,
        Method::GET,
        &format!("/api/v1/admin/challenge-sets/{set_id}/export"),
        Some(&admin_token),
        Body::empty(),
    )
    .await;
    assert_eq!(export_response.status(), StatusCode::OK);
    let export_bytes = response_bytes(export_response).await;
    let mut archive = zip::ZipArchive::new(Cursor::new(export_bytes)).expect("export should zip");
    let mut manifest = String::new();
    archive
        .by_name("manifest.json")
        .expect("manifest should exist")
        .read_to_string(&mut manifest)
        .expect("manifest should read");
    assert!(manifest.contains("Manual Set"));
    assert!(manifest.contains("manual-line"));
    assert!(archive.by_name("images/target.png").is_ok());
}

#[tokio::test]
async fn activating_challenge_set_archives_previous_active_set() {
    let state = AppState::new(Config::default());
    let repository = state.repository.clone();
    let first = repository
        .create_challenge_set("First", "v1", ChallengeSetStatus::Active)
        .expect("first set should create");
    let second = repository
        .create_challenge_set("Second", "v2", ChallengeSetStatus::Draft)
        .expect("second set should create");
    let admin_token = token_for(&state, "admin", Role::Admin);
    let app = router(state);

    let response = request(
        app,
        Method::POST,
        &format!(
            "/api/v1/admin/challenge-sets/{}/activate",
            second.id.as_uuid()
        ),
        Some(&admin_token),
        Body::empty(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let body = response_json(response).await;
    assert_eq!(body["id"], second.id.as_uuid().to_string());
    assert_eq!(body["status"], "active");

    let first = repository
        .get_challenge_set(first.id)
        .expect("store should read")
        .expect("first set should exist");
    let second = repository
        .get_challenge_set(second.id)
        .expect("store should read")
        .expect("second set should exist");
    assert_eq!(first.status, ChallengeSetStatus::Archived);
    assert_eq!(second.status, ChallengeSetStatus::Active);
}

fn valid_import_zip() -> Vec<u8> {
    zip_with_entries(vec![
        ("manifest.json", valid_manifest_bytes()),
        ("images/one.png", VALID_PNG_BYTES.to_vec()),
        ("images/two.png", VALID_PNG_BYTES.to_vec()),
    ])
}

fn duplicate_slug_zip() -> Vec<u8> {
    let manifest = json!({
        "name": "Imported Set",
        "version": "v1",
        "challenges": [
            challenge_manifest("same", "images/one.png", 1),
            challenge_manifest("same", "images/two.png", 2)
        ]
    });
    zip_with_entries(vec![
        (
            "manifest.json",
            serde_json::to_vec(&manifest).expect("manifest should serialize"),
        ),
        ("images/one.png", VALID_PNG_BYTES.to_vec()),
        ("images/two.png", VALID_PNG_BYTES.to_vec()),
    ])
}

fn valid_manifest_bytes() -> Vec<u8> {
    let manifest = json!({
        "name": "Imported Set",
        "version": "v1",
        "challenges": [
            challenge_manifest("one", "images/one.png", 1),
            challenge_manifest("two", "images/two.png", 2)
        ]
    });
    serde_json::to_vec(&manifest).expect("manifest should serialize")
}

fn manifest_bytes(image_path: &str) -> Vec<u8> {
    let manifest = json!({
        "name": "Imported Set",
        "version": "v1",
        "challenges": [challenge_manifest("one", image_path, 1)]
    });
    serde_json::to_vec(&manifest).expect("manifest should serialize")
}

fn challenge_manifest(slug: &str, image_path: &str, order: i32) -> Value {
    json!({
        "slug": slug,
        "title": format!("Challenge {slug}"),
        "description": "Draw the target",
        "target_image_path": image_path,
        "points": 100,
        "enabled": true,
        "order": order,
        "canvas": {
            "width": 800,
            "height": 600,
            "background_color": "#ffffff"
        },
        "judge_config": {}
    })
}

fn zip_with_entries(entries: Vec<(&str, Vec<u8>)>) -> Vec<u8> {
    let mut writer = ZipWriter::new(Cursor::new(Vec::new()));
    let options: SimpleFileOptions =
        FileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    for (path, bytes) in entries {
        writer
            .start_file(path, options)
            .expect("zip entry should start");
        writer.write_all(&bytes).expect("zip entry should write");
    }
    writer.finish().expect("zip should finish").into_inner()
}

async fn multipart_request(app: Router, uri: &str, token: &str, file: Vec<u8>) -> Response {
    multipart_request_with_content_type(
        app,
        uri,
        token,
        "challenge-set.zip",
        "application/zip",
        file,
    )
    .await
}

async fn multipart_request_with_content_type(
    app: Router,
    uri: &str,
    token: &str,
    file_name: &str,
    content_type: &str,
    file: Vec<u8>,
) -> Response {
    const BOUNDARY: &str = "BOUNDARY";
    let mut body = Vec::new();
    body.extend_from_slice(format!("--{BOUNDARY}\r\n").as_bytes());
    body.extend_from_slice(
        format!("Content-Disposition: form-data; name=\"file\"; filename=\"{file_name}\"\r\n")
            .as_bytes(),
    );
    body.extend_from_slice(format!("Content-Type: {content_type}\r\n\r\n").as_bytes());
    body.extend_from_slice(&file);
    body.extend_from_slice(format!("\r\n--{BOUNDARY}--\r\n").as_bytes());

    let request = Request::builder()
        .method(Method::POST)
        .uri(uri)
        .header(header::AUTHORIZATION, format!("Bearer {token}"))
        .header(
            header::CONTENT_TYPE,
            format!("multipart/form-data; boundary={BOUNDARY}"),
        )
        .body(Body::from(body))
        .expect("request should build");

    app.oneshot(request).await.expect("request should complete")
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
    let bytes = response_bytes(response).await;
    serde_json::from_slice(&bytes).expect("body should be json")
}

async fn response_bytes(response: Response) -> Vec<u8> {
    to_bytes(response.into_body(), 1024 * 1024)
        .await
        .expect("body should be readable")
        .to_vec()
}

fn token_for(state: &AppState, subject: impl Into<String>, role: Role) -> String {
    issue_token(subject, role, state.config.token_ttl, &state.auth_secret)
        .expect("token should issue")
}
