use axum::{Json, Router, extract::State, http::StatusCode, routing::get};
use serde::Serialize;

use crate::state::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/healthz", get(healthz))
        .route("/readyz", get(readyz))
}

async fn healthz() -> Json<HealthResponse> {
    Json(HealthResponse { ok: true })
}

async fn readyz(State(state): State<AppState>) -> (StatusCode, Json<ReadinessResponse>) {
    let database = state.services.database.readiness();
    let storage = state.services.storage.readiness();
    let ok = database.is_ok() && storage.is_ok();
    let status = if ok {
        StatusCode::OK
    } else {
        StatusCode::SERVICE_UNAVAILABLE
    };

    (
        status,
        Json(ReadinessResponse {
            ok,
            database: database.label(),
            storage: storage.label(),
        }),
    )
}

#[derive(Debug, Serialize)]
struct HealthResponse {
    ok: bool,
}

#[derive(Debug, Serialize)]
struct ReadinessResponse {
    ok: bool,
    database: &'static str,
    storage: &'static str,
}
