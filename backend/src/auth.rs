use std::time::Duration;

use axum::{
    extract::FromRequestParts,
    http::{header, request::Parts},
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use thiserror::Error;

use crate::{error::AppError, models::Role, state::AppState};

type HmacSha256 = Hmac<Sha256>;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuthenticatedUser {
    pub subject: String,
    pub role: Role,
    pub expires_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TeamUser(pub AuthenticatedUser);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AdminUser(pub AuthenticatedUser);

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AuthClaims {
    pub sub: String,
    pub role: Role,
    pub exp: i64,
    pub iat: i64,
}

impl AuthClaims {
    pub fn new(
        subject: impl Into<String>,
        role: Role,
        ttl: Duration,
        now: i64,
    ) -> Result<Self, TokenError> {
        let ttl_seconds = i64::try_from(ttl.as_secs()).map_err(|_| TokenError::InvalidTtl)?;
        let exp = now.checked_add(ttl_seconds).ok_or(TokenError::InvalidTtl)?;

        Ok(Self {
            sub: subject.into(),
            role,
            exp,
            iat: now,
        })
    }
}

pub fn issue_token(
    subject: impl Into<String>,
    role: Role,
    ttl: Duration,
    secret: &str,
) -> Result<String, TokenError> {
    let now = now_unix_timestamp();
    let claims = AuthClaims::new(subject, role, ttl, now)?;
    sign_token(&claims, secret)
}

pub fn sign_token(claims: &AuthClaims, secret: &str) -> Result<String, TokenError> {
    if secret.is_empty() {
        return Err(TokenError::EmptySecret);
    }

    let payload = serde_json::to_vec(claims).map_err(TokenError::EncodeClaims)?;
    let payload_part = URL_SAFE_NO_PAD.encode(payload);
    let signature = signature_for(payload_part.as_bytes(), secret)?;
    let signature_part = URL_SAFE_NO_PAD.encode(signature);

    Ok(format!("{payload_part}.{signature_part}"))
}

pub fn verify_token(token: &str, secret: &str) -> Result<AuthenticatedUser, TokenError> {
    verify_token_at(token, secret, now_unix_timestamp())
}

pub fn verify_token_at(
    token: &str,
    secret: &str,
    now: i64,
) -> Result<AuthenticatedUser, TokenError> {
    if secret.is_empty() {
        return Err(TokenError::EmptySecret);
    }

    let (payload_part, signature_part) = split_token(token)?;
    let signature = URL_SAFE_NO_PAD
        .decode(signature_part)
        .map_err(|_| TokenError::Malformed)?;

    let mut mac = HmacSha256::new_from_slice(secret.as_bytes()).map_err(|_| TokenError::Sign)?;
    mac.update(payload_part.as_bytes());
    mac.verify_slice(&signature)
        .map_err(|_| TokenError::InvalidSignature)?;

    let payload = URL_SAFE_NO_PAD
        .decode(payload_part)
        .map_err(|_| TokenError::Malformed)?;
    let claims: AuthClaims = serde_json::from_slice(&payload).map_err(TokenError::DecodeClaims)?;
    if claims.exp <= now {
        return Err(TokenError::Expired);
    }

    Ok(AuthenticatedUser {
        subject: claims.sub,
        role: claims.role,
        expires_at: claims.exp,
    })
}

pub fn bearer_token_from_parts(parts: &Parts) -> Result<&str, TokenError> {
    let value = parts
        .headers
        .get(header::AUTHORIZATION)
        .ok_or(TokenError::MissingBearerToken)?;
    let value = value
        .to_str()
        .map_err(|_| TokenError::MalformedBearerToken)?;
    let token = value
        .strip_prefix("Bearer ")
        .ok_or(TokenError::MalformedBearerToken)?;
    if token.is_empty() {
        return Err(TokenError::MalformedBearerToken);
    }

    Ok(token)
}

impl FromRequestParts<AppState> for AuthenticatedUser {
    type Rejection = AppError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        let token = bearer_token_from_parts(parts)?;
        verify_token(token, &state.auth_secret).map_err(AppError::from)
    }
}

impl FromRequestParts<AppState> for TeamUser {
    type Rejection = AppError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        let user = AuthenticatedUser::from_request_parts(parts, state).await?;
        if user.role != Role::Team {
            return Err(AppError::forbidden_code(
                "team_auth_required",
                "team authentication is required",
            ));
        }

        Ok(Self(user))
    }
}

impl FromRequestParts<AppState> for AdminUser {
    type Rejection = AppError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        let user = AuthenticatedUser::from_request_parts(parts, state).await?;
        if user.role != Role::Admin {
            return Err(AppError::forbidden_code(
                "admin_auth_required",
                "admin authentication is required",
            ));
        }

        Ok(Self(user))
    }
}

impl From<TokenError> for AppError {
    fn from(error: TokenError) -> Self {
        AppError::unauthorized(error.public_message())
    }
}

#[derive(Debug, Error)]
pub enum TokenError {
    #[error("token secret is empty")]
    EmptySecret,
    #[error("token ttl is invalid")]
    InvalidTtl,
    #[error("token is malformed")]
    Malformed,
    #[error("token signature is invalid")]
    InvalidSignature,
    #[error("token has expired")]
    Expired,
    #[error("authorization bearer token is missing")]
    MissingBearerToken,
    #[error("authorization bearer token is malformed")]
    MalformedBearerToken,
    #[error("failed to encode claims")]
    EncodeClaims(#[source] serde_json::Error),
    #[error("failed to decode claims")]
    DecodeClaims(#[source] serde_json::Error),
    #[error("failed to sign token")]
    Sign,
}

impl TokenError {
    fn public_message(&self) -> &'static str {
        match self {
            Self::Expired => "token has expired",
            Self::MissingBearerToken => "authorization bearer token is missing",
            Self::MalformedBearerToken => "authorization bearer token is malformed",
            Self::EmptySecret
            | Self::InvalidTtl
            | Self::Malformed
            | Self::InvalidSignature
            | Self::EncodeClaims(_)
            | Self::DecodeClaims(_)
            | Self::Sign => "token is invalid",
        }
    }
}

fn split_token(token: &str) -> Result<(&str, &str), TokenError> {
    let mut parts = token.split('.');
    let payload_part = parts.next().ok_or(TokenError::Malformed)?;
    let signature_part = parts.next().ok_or(TokenError::Malformed)?;
    if parts.next().is_some() || payload_part.is_empty() || signature_part.is_empty() {
        return Err(TokenError::Malformed);
    }

    Ok((payload_part, signature_part))
}

fn signature_for(message: &[u8], secret: &str) -> Result<Vec<u8>, TokenError> {
    let mut mac = HmacSha256::new_from_slice(secret.as_bytes()).map_err(|_| TokenError::Sign)?;
    mac.update(message);
    Ok(mac.finalize().into_bytes().to_vec())
}

fn now_unix_timestamp() -> i64 {
    match std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH) {
        Ok(duration) => i64::try_from(duration.as_secs()).unwrap_or(i64::MAX),
        Err(_) => 0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SECRET: &str = "test-secret";

    #[test]
    fn token_round_trip_preserves_claims() {
        let claims = AuthClaims::new("team-1", Role::Team, Duration::from_secs(60), 1_000)
            .expect("claims should be valid");
        let token = sign_token(&claims, SECRET).expect("token should sign");

        let user = verify_token_at(&token, SECRET, 1_010).expect("token should verify");

        assert_eq!(user.subject, "team-1");
        assert_eq!(user.role, Role::Team);
        assert_eq!(user.expires_at, 1_060);
    }

    #[test]
    fn token_rejects_invalid_signature() {
        let claims = AuthClaims::new("admin-1", Role::Admin, Duration::from_secs(60), 1_000)
            .expect("claims should be valid");
        let token = sign_token(&claims, SECRET).expect("token should sign");

        let error =
            verify_token_at(&token, "different-secret", 1_010).expect_err("signature should fail");

        assert!(matches!(error, TokenError::InvalidSignature));
    }

    #[test]
    fn token_rejects_expired_claims() {
        let claims = AuthClaims::new("team-1", Role::Team, Duration::from_secs(60), 1_000)
            .expect("claims should be valid");
        let token = sign_token(&claims, SECRET).expect("token should sign");

        let error = verify_token_at(&token, SECRET, 1_061).expect_err("token should expire");

        assert!(matches!(error, TokenError::Expired));
    }
}
