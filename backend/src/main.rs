use std::error::Error;

use backend::{
    config::Config, router, routes::submissions::judge_next_submission_once, state::AppState,
};
use tokio::net::TcpListener;
use tracing_subscriber::EnvFilter;
use dotenvy::dotenv;

#[tokio::main]
async fn main() -> Result<(), Box<dyn Error>> {
    dotenv().ok();
    init_tracing();

    let config = Config::from_env()?;
    let listener = TcpListener::bind(config.bind_addr).await?;
    let state = AppState::new(config);
    tokio::spawn(judge_worker_loop(state.clone()));

    tracing::info!(addr = %listener.local_addr()?, "starting http server");
    axum::serve(listener, router(state))
        .with_graceful_shutdown(shutdown_signal())
        .await?;

    Ok(())
}

async fn judge_worker_loop(state: AppState) {
    let mut interval = tokio::time::interval(std::time::Duration::from_millis(250));
    loop {
        interval.tick().await;
        match judge_next_submission_once(state.clone()).await {
            Ok(Some(submission)) => {
                tracing::info!(
                    submission_id = %submission.id.as_uuid(),
                    status = ?submission.status,
                    "judge worker processed submission"
                );
            }
            Ok(None) => {}
            Err(error) => {
                tracing::warn!(?error, "judge worker failed to process submission");
            }
        }
    }
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
