pub mod admin_challenges;
pub mod admin_submissions;
pub mod admin_teams;
pub mod auth;
pub mod blackboard;
pub mod challenges;
pub mod health;
pub mod scores;
pub mod submissions;

use axum::{Json, Router, http::Uri, routing::get};
use serde::Serialize;
use serde_json::json;

use crate::{error::AppError, state::AppState};

pub fn router(state: AppState) -> Router {
    Router::new()
        .merge(health::router())
        .nest("/api/v1", api_v1_router())
        .fallback(global_not_found)
        .with_state(state)
}

fn api_v1_router() -> Router<AppState> {
    Router::new()
        .route("/", get(api_index))
        .merge(auth::router())
        .merge(admin_teams::router())
        .merge(challenges::router())
        .merge(admin_challenges::router())
        .merge(submissions::router())
        .merge(admin_submissions::router())
        .merge(scores::router())
        .merge(blackboard::router())
        .fallback(api_not_found)
}

async fn api_index() -> Json<ApiIndexResponse> {
    Json(ApiIndexResponse {
        ok: true,
        version: "v1",
    })
}

async fn api_not_found(uri: Uri) -> AppError {
    AppError::not_found("api route not found").with_details(json!({ "path": uri.path() }))
}

async fn global_not_found(uri: Uri) -> AppError {
    AppError::not_found("route not found").with_details(json!({ "path": uri.path() }))
}

#[derive(Debug, Serialize)]
struct ApiIndexResponse {
    ok: bool,
    version: &'static str,
}
