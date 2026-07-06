use axum::{
    Json,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde::Serialize;
use serde_json::Value;

use crate::state::StoreError;

#[derive(Debug, Clone)]
pub struct AppError {
    status: StatusCode,
    code: &'static str,
    message: String,
    details: Option<Value>,
}

impl AppError {
    pub fn bad_request(message: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_REQUEST, "bad_request", message, None)
    }

    pub fn bad_request_code(code: &'static str, message: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_REQUEST, code, message, None)
    }

    pub fn unauthorized(message: impl Into<String>) -> Self {
        Self::new(StatusCode::UNAUTHORIZED, "unauthorized", message, None)
    }

    pub fn unauthorized_code(code: &'static str, message: impl Into<String>) -> Self {
        Self::new(StatusCode::UNAUTHORIZED, code, message, None)
    }

    pub fn forbidden(message: impl Into<String>) -> Self {
        Self::new(StatusCode::FORBIDDEN, "forbidden", message, None)
    }

    pub fn too_many_requests(message: impl Into<String>) -> Self {
        Self::new(
            StatusCode::TOO_MANY_REQUESTS,
            "too_many_requests",
            message,
            None,
        )
    }

    pub fn forbidden_code(code: &'static str, message: impl Into<String>) -> Self {
        Self::new(StatusCode::FORBIDDEN, code, message, None)
    }

    pub fn not_found(message: impl Into<String>) -> Self {
        Self::new(StatusCode::NOT_FOUND, "not_found", message, None)
    }

    pub fn not_found_code(code: &'static str, message: impl Into<String>) -> Self {
        Self::new(StatusCode::NOT_FOUND, code, message, None)
    }

    pub fn conflict_code(code: &'static str, message: impl Into<String>) -> Self {
        Self::new(StatusCode::CONFLICT, code, message, None)
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Self::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "internal_error",
            message,
            None,
        )
    }

    pub fn with_details(mut self, details: Value) -> Self {
        self.details = Some(details);
        self
    }

    fn new(
        status: StatusCode,
        code: &'static str,
        message: impl Into<String>,
        details: Option<Value>,
    ) -> Self {
        Self {
            status,
            code,
            message: message.into(),
            details,
        }
    }
}

impl From<StoreError> for AppError {
    fn from(error: StoreError) -> Self {
        match error {
            StoreError::LockUnavailable => Self::internal("store lock is unavailable"),
            StoreError::NotFound { entity } => Self::not_found(format!("{entity} was not found")),
            StoreError::SubmissionNotQueued => Self::bad_request("submission is not queued"),
            StoreError::DuplicateLoginCode => Self::bad_request("team login code already exists"),
            StoreError::DuplicateChallengeSlug => {
                Self::bad_request("challenge slug already exists in this set")
            }
            StoreError::DuplicateChallengePass => {
                Self::bad_request("challenge pass score event already exists")
            }
            StoreError::InvalidatedStreamSession => {
                Self::bad_request_code("stream_session_invalid", "stream session id is invalid")
            }
            StoreError::ScoreOverflow => Self::bad_request("score update overflowed"),
            StoreError::AdminSetRequiresScore => {
                Self::bad_request("admin set score event requires a target score")
            }
            StoreError::ChallengePassRequiresChallenge => {
                Self::bad_request("challenge pass score event requires a challenge reference")
            }
            StoreError::CannotArchiveOnlyActive => {
                Self::bad_request("cannot archive the only active challenge set")
            }
        }
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let status = self.status;
        let body = ErrorResponse {
            error: ErrorBody {
                code: self.code,
                message: self.message,
                details: self.details,
            },
        };

        (status, Json(body)).into_response()
    }
}

#[derive(Debug, Serialize)]
pub struct ErrorResponse {
    pub error: ErrorBody,
}

#[derive(Debug, Serialize)]
pub struct ErrorBody {
    pub code: &'static str,
    pub message: String,
    pub details: Option<Value>,
}
