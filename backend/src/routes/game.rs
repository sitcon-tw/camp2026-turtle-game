use std::{collections::HashSet, convert::Infallible};

use axum::{
    Json, Router,
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{
        Sse,
        sse::{Event, KeepAlive},
    },
    routing::{get, patch, post},
};
use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio_stream::{StreamExt, wrappers::BroadcastStream};
use uuid::Uuid;

use crate::{
    auth::{AdminUser, AuthenticatedUser},
    error::AppError,
    models::{
        Challenge, ChallengeId, GamePhase, GameStateView, PublicVote, PublicVoteChoice, Role,
        Round, RoundResultEntry, Submission, TeamId, TeamNomination, TeamSelectionVote,
    },
    routes::submissions::judge_and_store_submission,
    state::{
        AppEvent, AppState, GameError, GameSnapshot, PublicVoteCount, RateLimitStatus,
        StartRoundInput,
    },
};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/game/state", get(game_state))
        .route("/game/events", get(game_events))
        .route(
            "/game/rounds/current/submissions",
            post(create_current_round_submission),
        )
        .route(
            "/game/rounds/current/team-selection-votes",
            post(record_team_selection_vote),
        )
        .route(
            "/game/rounds/current/public-votes",
            post(record_public_vote),
        )
        .route("/admin/game/rounds", post(start_round))
        .route("/admin/game/timer", patch(update_timer))
        .route("/admin/game/phase", post(set_phase))
        .route("/admin/game/score", post(score_round))
}

#[derive(Debug, Serialize)]
pub(crate) struct GameStateResponse {
    state: GameStateView,
    round: Option<Round>,
    challenge: Option<Challenge>,
    round_submissions: Vec<Submission>,
    my_submissions: Vec<Submission>,
    nominations: Vec<TeamNomination>,
    my_team_selection_vote: Option<TeamSelectionVote>,
    my_public_vote: Option<PublicVote>,
    public_vote_counts: Vec<PublicVoteCount>,
    results: Vec<RoundResultEntry>,
}

impl From<GameSnapshot> for GameStateResponse {
    fn from(snapshot: GameSnapshot) -> Self {
        Self {
            state: snapshot.state,
            round: snapshot.round,
            challenge: snapshot.challenge,
            round_submissions: snapshot.round_submissions,
            my_submissions: snapshot.my_submissions,
            nominations: snapshot.nominations,
            my_team_selection_vote: snapshot.my_team_selection_vote,
            my_public_vote: snapshot.my_public_vote,
            public_vote_counts: snapshot.public_vote_counts,
            results: snapshot.results,
        }
    }
}

async fn game_state(
    State(state): State<AppState>,
    user: AuthenticatedUser,
) -> Result<Json<GameStateResponse>, AppError> {
    let team_id = if user.role == Role::Team {
        Some(parse_team_id(&user.subject)?)
    } else {
        None
    };
    let snapshot = state
        .game
        .snapshot(state.repository.as_ref(), team_id)
        .map_err(game_error)?;
    Ok(Json(snapshot.into()))
}

async fn game_events(
    State(state): State<AppState>,
    user: AuthenticatedUser,
) -> Result<Sse<impl tokio_stream::Stream<Item = Result<Event, Infallible>>>, AppError> {
    let team_id = if user.role == Role::Team {
        Some(parse_team_id(&user.subject)?)
    } else {
        None
    };
    let initial = game_snapshot_event(&state, team_id)?;
    let stream_state = state.clone();
    let updates = BroadcastStream::new(state.event_bus.subscribe()).filter_map(move |message| {
        let event = match message {
            Ok(event) => event,
            Err(_) => return None,
        };
        if !matches!(
            event,
            AppEvent::GameStateChanged { .. } | AppEvent::RoundUpdated { .. }
        ) {
            return None;
        }
        game_snapshot_event(&stream_state, team_id).ok().map(Ok)
    });
    let stream = tokio_stream::once(Ok(initial)).chain(updates);
    Ok(Sse::new(stream).keep_alive(KeepAlive::default()))
}

#[derive(Debug, Deserialize)]
struct StartRoundRequest {
    challenge_id: ChallengeId,
    submission_seconds: i64,
    #[serde(default = "default_public_votes_per_team")]
    public_votes_per_team: u8,
}

async fn start_round(
    AdminUser(user): AdminUser,
    State(state): State<AppState>,
    Json(payload): Json<StartRoundRequest>,
) -> Result<(StatusCode, Json<GameStateResponse>), AppError> {
    let view = state
        .game
        .start_round(
            state.repository.as_ref(),
            StartRoundInput {
                challenge_id: payload.challenge_id,
                submission_seconds: payload.submission_seconds,
                public_votes_per_team: payload.public_votes_per_team,
                created_by: Some(user.subject),
            },
        )
        .map_err(game_error)?;
    publish_game(&state, view.version);
    let snapshot = state
        .game
        .snapshot(state.repository.as_ref(), None)
        .map_err(game_error)?;
    Ok((StatusCode::CREATED, Json(snapshot.into())))
}

#[derive(Debug, Deserialize)]
struct TimerRequest {
    phase_ends_at: Option<DateTime<Utc>>,
    add_seconds: Option<i64>,
}

async fn update_timer(
    AdminUser(user): AdminUser,
    State(state): State<AppState>,
    Json(payload): Json<TimerRequest>,
) -> Result<Json<GameStateResponse>, AppError> {
    let phase_ends_at = match (payload.phase_ends_at, payload.add_seconds) {
        (Some(deadline), _) => deadline,
        (None, Some(seconds)) => Utc::now() + Duration::seconds(seconds),
        (None, None) => {
            return Err(AppError::bad_request(
                "timer update requires phase_ends_at or add_seconds",
            ));
        }
    };
    let view = state
        .game
        .update_timer(phase_ends_at, Some(user.subject))
        .map_err(game_error)?;
    publish_game(&state, view.version);
    Ok(Json(
        state
            .game
            .snapshot(state.repository.as_ref(), None)
            .map_err(game_error)?
            .into(),
    ))
}

#[derive(Debug, Deserialize)]
struct PhaseRequest {
    phase: GamePhase,
}

async fn set_phase(
    AdminUser(user): AdminUser,
    State(state): State<AppState>,
    Json(payload): Json<PhaseRequest>,
) -> Result<Json<GameStateResponse>, AppError> {
    let view = state
        .game
        .set_phase(payload.phase, Some(user.subject))
        .map_err(game_error)?;
    publish_game(&state, view.version);
    Ok(Json(
        state
            .game
            .snapshot(state.repository.as_ref(), None)
            .map_err(game_error)?
            .into(),
    ))
}

#[derive(Debug, Deserialize)]
struct SubmitRequest {
    block_program: Value,
}

#[derive(Debug, Serialize)]
struct SubmissionResponse {
    submission: Submission,
}

async fn create_current_round_submission(
    State(state): State<AppState>,
    user: AuthenticatedUser,
    Json(payload): Json<SubmitRequest>,
) -> Result<(StatusCode, Json<SubmissionResponse>), AppError> {
    let team_id = require_team_user(&user)?;
    let snapshot = state
        .game
        .snapshot(state.repository.as_ref(), Some(team_id))
        .map_err(game_error)?;
    if snapshot.state.phase != GamePhase::SubmissionOpen {
        return Err(AppError::bad_request(
            "game phase does not allow submissions",
        ));
    }
    if snapshot
        .state
        .phase_ends_at
        .is_some_and(|deadline| Utc::now() > deadline)
    {
        return Err(AppError::forbidden("submission deadline has passed"));
    }
    let challenge_id = snapshot
        .state
        .current_challenge_id
        .ok_or_else(|| AppError::bad_request("no active challenge"))?;
    match state
        .repository
        .submission_rate_limit(team_id, Utc::now())?
    {
        RateLimitStatus::Allowed => {}
        RateLimitStatus::Limited { allowed_at } => {
            return Err(
                AppError::too_many_requests("submission rate limit exceeded")
                    .with_details(json!({ "allowed_at": allowed_at })),
            );
        }
    }
    let submission =
        state
            .repository
            .create_submission(team_id, challenge_id, payload.block_program, None)?;
    let view = state
        .game
        .attach_submission(&submission)
        .map_err(game_error)?;
    let submission = judge_and_store_submission(&state, submission).await?;
    state.event_bus.publish(AppEvent::RoundUpdated {
        round_id: view
            .current_round_id
            .expect("current round exists after attach"),
        version: view.version,
    });
    Ok((StatusCode::CREATED, Json(SubmissionResponse { submission })))
}

#[derive(Debug, Deserialize)]
struct TeamSelectionVoteRequest {
    submission_id: crate::models::SubmissionId,
}

async fn record_team_selection_vote(
    State(state): State<AppState>,
    user: AuthenticatedUser,
    headers: HeaderMap,
    Json(payload): Json<TeamSelectionVoteRequest>,
) -> Result<Json<TeamSelectionVote>, AppError> {
    let team_id = require_team_user(&user)?;
    let device_id = device_id(&headers)?;
    let (vote, view) = state
        .game
        .record_team_selection_vote(
            state.repository.as_ref(),
            team_id,
            device_id,
            payload.submission_id,
        )
        .map_err(game_error)?;
    state.event_bus.publish(AppEvent::RoundUpdated {
        round_id: view
            .current_round_id
            .expect("current round exists after vote"),
        version: view.version,
    });
    Ok(Json(vote))
}

#[derive(Debug, Deserialize)]
struct PublicVoteRequest {
    votes: Vec<PublicVoteChoice>,
}

async fn record_public_vote(
    State(state): State<AppState>,
    user: AuthenticatedUser,
    Json(payload): Json<PublicVoteRequest>,
) -> Result<Json<PublicVote>, AppError> {
    let team_id = require_team_user(&user)?;
    let normalized = normalize_public_choices(payload.votes)?;
    let (vote, view) = state
        .game
        .record_public_vote(team_id, normalized)
        .map_err(game_error)?;
    state.event_bus.publish(AppEvent::RoundUpdated {
        round_id: view
            .current_round_id
            .expect("current round exists after public vote"),
        version: view.version,
    });
    Ok(Json(vote))
}

async fn score_round(
    AdminUser(user): AdminUser,
    State(state): State<AppState>,
) -> Result<Json<GameStateResponse>, AppError> {
    let (_results, view) = state
        .game
        .score_current_round(state.repository.as_ref(), Some(user.subject))
        .map_err(game_error)?;
    publish_game(&state, view.version);
    state.event_bus.publish(AppEvent::LeaderboardUpdated);
    Ok(Json(
        state
            .game
            .snapshot(state.repository.as_ref(), None)
            .map_err(game_error)?
            .into(),
    ))
}

fn publish_game(state: &AppState, version: i64) {
    state
        .event_bus
        .publish(AppEvent::GameStateChanged { version });
}

fn game_snapshot_event(state: &AppState, team_id: Option<TeamId>) -> Result<Event, AppError> {
    let snapshot: GameStateResponse = state
        .game
        .snapshot(state.repository.as_ref(), team_id)
        .map_err(game_error)?
        .into();
    let data = serde_json::to_string(&snapshot).map_err(|error| {
        AppError::internal(format!("failed to serialize game snapshot: {error}"))
    })?;
    Ok(Event::default().event("game_state_snapshot").data(data))
}

fn require_team_user(user: &AuthenticatedUser) -> Result<TeamId, AppError> {
    if user.role != Role::Team {
        return Err(AppError::forbidden("team authentication is required"));
    }
    parse_team_id(&user.subject)
}

fn parse_team_id(subject: &str) -> Result<TeamId, AppError> {
    Uuid::parse_str(subject)
        .map(TeamId::from)
        .map_err(|_| AppError::unauthorized("token subject is invalid"))
}

fn device_id(headers: &HeaderMap) -> Result<String, AppError> {
    let value = headers
        .get("x-device-id")
        .ok_or_else(|| AppError::bad_request("x-device-id header is required"))?;
    let value = value
        .to_str()
        .map_err(|_| AppError::bad_request("x-device-id header is invalid"))?
        .trim();
    if value.is_empty() {
        return Err(AppError::bad_request("x-device-id header is required"));
    }
    Ok(value.to_owned())
}

fn normalize_public_choices(
    mut votes: Vec<PublicVoteChoice>,
) -> Result<Vec<PublicVoteChoice>, AppError> {
    votes.sort_by_key(|vote| vote.rank);
    let mut ranks = HashSet::new();
    for vote in &votes {
        if vote.rank == 0 || !ranks.insert(vote.rank) {
            return Err(AppError::bad_request(
                "public vote ranks must be unique and positive",
            ));
        }
    }
    Ok(votes)
}

fn game_error(error: GameError) -> AppError {
    match error {
        GameError::LockUnavailable => AppError::internal("game store is unavailable"),
        GameError::ChallengeNotFound
        | GameError::SubmissionNotFound
        | GameError::NominationNotFound => AppError::not_found(error.to_string()),
        GameError::TeamNotFound
        | GameError::NoActiveRound
        | GameError::InvalidPhase
        | GameError::SubmissionNotInRound
        | GameError::SubmissionTeamMismatch
        | GameError::InvalidPublicVote => AppError::bad_request(error.to_string()),
        GameError::DeadlinePassed => AppError::forbidden(error.to_string()),
    }
}

const fn default_public_votes_per_team() -> u8 {
    3
}
