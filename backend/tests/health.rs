use axum::{
    body::to_bytes,
    http::{Request, StatusCode},
};
use backend::{
    config::Config,
    router,
    state::{AppServices, AppState, Database, ServiceReadiness, Storage},
};
use serde_json::Value;
use std::sync::Arc;
use tower::ServiceExt;

#[tokio::test]
async fn healthz_returns_ok() {
    let app = router(AppState::new(Config::default()));

    let response = app
        .oneshot(
            Request::builder()
                .uri("/healthz")
                .body(axum::body::Body::empty())
                .expect("request should build"),
        )
        .await
        .expect("request should complete");

    assert_eq!(response.status(), StatusCode::OK);
    let body = response_json(response).await;
    assert_eq!(body["ok"], true);
}

#[tokio::test]
async fn readyz_returns_dependency_status() {
    let app = router(AppState::new(Config::default()));

    let response = app
        .oneshot(
            Request::builder()
                .uri("/readyz")
                .body(axum::body::Body::empty())
                .expect("request should build"),
        )
        .await
        .expect("request should complete");

    assert_eq!(response.status(), StatusCode::OK);
    let body = response_json(response).await;
    assert_eq!(body["ok"], true);
    assert_eq!(body["database"], "ok");
    assert_eq!(body["storage"], "ok");
}

#[tokio::test]
async fn readyz_reports_unavailable_dependencies() {
    let services = AppServices {
        database: Arc::new(UnavailableDatabase),
        storage: Arc::new(UnavailableStorage),
    };
    let app = router(AppState::new(Config::default()).with_services(services));

    let response = app
        .oneshot(
            Request::builder()
                .uri("/readyz")
                .body(axum::body::Body::empty())
                .expect("request should build"),
        )
        .await
        .expect("request should complete");

    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    let body = response_json(response).await;
    assert_eq!(body["ok"], false);
    assert_eq!(body["database"], "unavailable");
    assert_eq!(body["storage"], "unavailable");
}

async fn response_json(response: axum::response::Response) -> Value {
    let bytes = to_bytes(response.into_body(), 1024 * 1024)
        .await
        .expect("body should be readable");
    serde_json::from_slice(&bytes).expect("body should be json")
}

struct UnavailableDatabase;

impl Database for UnavailableDatabase {
    fn readiness(&self) -> ServiceReadiness {
        ServiceReadiness::Unavailable("database unavailable in test".to_owned())
    }
}

struct UnavailableStorage;

impl Storage for UnavailableStorage {
    fn readiness(&self) -> ServiceReadiness {
        ServiceReadiness::Unavailable("storage unavailable in test".to_owned())
    }
}
