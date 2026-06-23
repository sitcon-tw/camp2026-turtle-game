use std::{env, net::SocketAddr, path::PathBuf, time::Duration};

use thiserror::Error;

#[derive(Debug, Clone)]
pub struct Config {
    pub bind_addr: SocketAddr,
    pub storage_root: PathBuf,
    pub auth_secret: String,
    pub token_ttl: Duration,
}

impl Config {
    pub fn from_env() -> Result<Self, ConfigError> {
        let default = Self::default();
        let host = optional_env("APP_HOST")?.unwrap_or_else(|| default.bind_addr.ip().to_string());
        let port = match env::var("APP_PORT") {
            Ok(value) => value
                .parse::<u16>()
                .map_err(|source| ConfigError::InvalidPort { source })?,
            Err(env::VarError::NotPresent) => default.bind_addr.port(),
            Err(env::VarError::NotUnicode(_)) => return Err(ConfigError::NonUnicode("APP_PORT")),
        };
        let bind_addr = format!("{host}:{port}")
            .parse()
            .map_err(|source| ConfigError::InvalidBindAddress { source })?;

        let storage_root = optional_env("STORAGE_ROOT")?
            .map(PathBuf::from)
            .unwrap_or(default.storage_root);
        let auth_secret = optional_env("AUTH_SECRET")?.unwrap_or(default.auth_secret);
        if auth_secret.trim().is_empty() {
            return Err(ConfigError::EmptyAuthSecret);
        }

        let token_ttl_seconds = match env::var("TOKEN_TTL_SECONDS") {
            Ok(value) => value
                .parse::<u64>()
                .map_err(|source| ConfigError::InvalidTokenTtl { source })?,
            Err(env::VarError::NotPresent) => default.token_ttl.as_secs(),
            Err(env::VarError::NotUnicode(_)) => {
                return Err(ConfigError::NonUnicode("TOKEN_TTL_SECONDS"));
            }
        };

        Ok(Self {
            bind_addr,
            storage_root,
            auth_secret,
            token_ttl: Duration::from_secs(token_ttl_seconds),
        })
    }
}

fn optional_env(name: &'static str) -> Result<Option<String>, ConfigError> {
    match env::var(name) {
        Ok(value) => Ok(Some(value)),
        Err(env::VarError::NotPresent) => Ok(None),
        Err(env::VarError::NotUnicode(_)) => Err(ConfigError::NonUnicode(name)),
    }
}

impl Default for Config {
    fn default() -> Self {
        Self {
            bind_addr: SocketAddr::from(([127, 0, 0, 1], 3000)),
            storage_root: PathBuf::from("storage"),
            auth_secret: "development-secret-change-me".to_owned(),
            token_ttl: Duration::from_secs(60 * 60),
        }
    }
}

#[derive(Debug, Error)]
pub enum ConfigError {
    #[error("invalid APP_PORT")]
    InvalidPort {
        #[source]
        source: std::num::ParseIntError,
    },
    #[error("invalid APP_HOST or APP_PORT bind address")]
    InvalidBindAddress {
        #[source]
        source: std::net::AddrParseError,
    },
    #[error("AUTH_SECRET must not be empty")]
    EmptyAuthSecret,
    #[error("invalid TOKEN_TTL_SECONDS")]
    InvalidTokenTtl {
        #[source]
        source: std::num::ParseIntError,
    },
    #[error("{0} must be valid unicode")]
    NonUnicode(&'static str),
}
