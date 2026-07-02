use std::error::Error;

use backend::{config::Config, router, state::AppState};
use dotenvy::dotenv;
use tokio::net::TcpListener;
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> Result<(), Box<dyn Error>> {
    dotenv().ok();
    init_tracing();

    let config = Config::from_env()?;
    let listener = TcpListener::bind(config.bind_addr).await?;
    let state = AppState::new(config);

    tracing::info!(addr = %listener.local_addr()?, "starting http server");
    axum::serve(listener, router(state))
        .with_graceful_shutdown(shutdown_signal())
        .await?;

    Ok(())
}

fn init_tracing() {
    let filter =
        EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("backend=info"));
    tracing_subscriber::fmt().with_env_filter(filter).init();
}

async fn shutdown_signal() {
    if let Err(error) = tokio::signal::ctrl_c().await {
        tracing::warn!(%error, "failed to listen for shutdown signal");
    }
}
