use std::{collections::HashMap, convert::Infallible};

use axum::{
    Json, Router,
    extract::{Path, State},
    http::{HeaderMap, HeaderValue, StatusCode, header},
    response::{
        IntoResponse, Response, Sse,
        sse::{Event, KeepAlive},
    },
    routing::{get, post},
};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio_stream::{StreamExt, wrappers::BroadcastStream};
use uuid::Uuid;

use crate::{
    auth::{AdminUser, AuthenticatedUser},
    engine::{BlockProgram, EngineError, interpret_program, render_program_png},
    error::AppError,
    models::{
        ChallengeId, Role, ScoreEvent, ScoreEventType, Submission, SubmissionId, TeamId, Timestamp,
    },
    state::{
        AppEvent, AppState, CompletedSubmission, RateLimitStatus, ScoreEventListFilter,
        SubmissionListFilter,
    },
};

const RESULT_CONTENT_TYPE: &str = "image/png";
const TRACE_STEP_PLAYBACK_MS: u64 = 500;

pub fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/challenges/{challenge_id}/submissions",
            post(create_submission).get(list_my_challenge_submissions),
        )
        .route(
            "/admin/submissions/{submission_id}/blackboard-playback",
            post(play_submission_on_blackboard),
        )
        .route("/submissions/{submission_id}", get(get_my_submission))
        .route("/leaderboard", get(leaderboard))
        .route("/leaderboard/events", get(leaderboard_events))
        .route("/events/team", get(team_events))
        .route("/assets/challenges/{asset_id}", get(challenge_asset))
        .route("/assets/results/{submission_id_png}", get(result_asset))
}

#[derive(Debug, Deserialize)]
struct SubmitRequest {
    block_program: Value,
}

#[derive(Debug, Serialize)]
struct SubmissionCreatedResponse {
    submission: Submission,
}

#[derive(Debug, Serialize)]
struct BlackboardPlaybackResponse {
    played: bool,
    submission_id: SubmissionId,
}

async fn create_submission(
    State(state): State<AppState>,
    user: AuthenticatedUser,
    Path(challenge_id): Path<ChallengeId>,
    Json(payload): Json<SubmitRequest>,
) -> Result<(StatusCode, Json<SubmissionCreatedResponse>), AppError> {
    let team_id = require_team(&user)?;
    let team = state
        .repository
        .get_team(team_id)?
        .ok_or_else(|| AppError::not_found("team was not found"))?;
    if !team.enabled {
        return Err(AppError::forbidden("team is disabled"));
    }
    let challenge = state
        .repository
        .get_challenge(challenge_id)?
        .ok_or_else(|| AppError::not_found("challenge was not found"))?;
    let active_set = state
        .repository
        .active_challenge_set()?
        .ok_or_else(|| AppError::not_found("challenge was not found"))?;
    if challenge.challenge_set_id != active_set.id {
        return Err(AppError::not_found("challenge was not found"));
    }
    if !challenge.enabled {
        return Err(AppError::forbidden("challenge is disabled"));
    }

    match state
        .repository
        .submission_rate_limit(team_id, Utc::now())?
    {
        RateLimitStatus::Allowed => {}
        RateLimitStatus::Limited { allowed_at } => {
            return Err(
                AppError::too_many_requests("submission rate limit exceeded")
                    .with_details(serde_json::json!({ "allowed_at": allowed_at })),
            );
        }
    }

    let block_program = validated_program_value(payload.block_program)?;
    let submission =
        state
            .repository
            .create_submission(team_id, challenge_id, block_program, None)?;
    let submission = judge_and_store_submission(&state, submission).await?;

    Ok((
        StatusCode::CREATED,
        Json(SubmissionCreatedResponse { submission }),
    ))
}

async fn list_my_challenge_submissions(
    State(state): State<AppState>,
    user: AuthenticatedUser,
    Path(challenge_id): Path<ChallengeId>,
) -> Result<Json<Vec<Submission>>, AppError> {
    let team_id = require_team(&user)?;
    let submissions = state.repository.list_submissions(SubmissionListFilter {
        team_id: Some(team_id),
        challenge_id: Some(challenge_id),
        status: None,
    })?;
    Ok(Json(submissions))
}

async fn get_my_submission(
    State(state): State<AppState>,
    user: AuthenticatedUser,
    Path(submission_id): Path<SubmissionId>,
) -> Result<Json<Submission>, AppError> {
    let team_id = require_team(&user)?;
    let submission = state
        .repository
        .get_submission(submission_id)?
        .ok_or_else(|| AppError::not_found("submission was not found"))?;
    if submission.team_id != team_id {
        return Err(AppError::forbidden("submission belongs to another team"));
    }
    Ok(Json(submission))
}

async fn play_submission_on_blackboard(
    AdminUser(_user): AdminUser,
    State(state): State<AppState>,
    Path(submission_id): Path<SubmissionId>,
) -> Result<Json<BlackboardPlaybackResponse>, AppError> {
    play_completed_submission_for_blackboard(&state, submission_id).await?;
    state
        .blackboard
        .set_selected_submission_id(Some(submission_id))?;
    state
        .event_bus
        .publish(AppEvent::BlackboardPlaybackChanged {
            submission_id: Some(submission_id),
        });
    Ok(Json(BlackboardPlaybackResponse {
        played: true,
        submission_id,
    }))
}

#[derive(Debug, Serialize)]
pub(crate) struct LeaderboardEntry {
    pub rank: usize,
    pub team_id: TeamId,
    pub team_name: String,
    pub total_score: i32,
    pub solved_count: usize,
    pub last_score_event_at: Option<Timestamp>,
}

#[derive(Debug, Serialize)]
struct LeaderboardResponse {
    teams: Vec<LeaderboardEntry>,
    updated_at: Timestamp,
}

#[derive(Debug, Clone, Copy, Default)]
struct LeaderboardScoreStats {
    solved_count: usize,
    last_score_event_at: Option<Timestamp>,
}

pub(crate) fn leaderboard_entries(teams: Vec<crate::models::Team>) -> Vec<LeaderboardEntry> {
    leaderboard_entries_with_score_events(teams, &[])
}

fn leaderboard_entries_with_score_events(
    teams: Vec<crate::models::Team>,
    score_events: &[ScoreEvent],
) -> Vec<LeaderboardEntry> {
    let stats = leaderboard_score_stats(score_events);
    teams
        .into_iter()
        .enumerate()
        .map(|(index, team)| {
            let score_stats = stats.get(&team.id).copied().unwrap_or_default();
            LeaderboardEntry {
                rank: index.saturating_add(1),
                team_id: team.id,
                team_name: team.name,
                total_score: team.total_score,
                solved_count: score_stats.solved_count,
                last_score_event_at: score_stats.last_score_event_at,
            }
        })
        .collect()
}

async fn leaderboard(State(state): State<AppState>) -> Result<Json<LeaderboardResponse>, AppError> {
    Ok(Json(leaderboard_response(&state)?))
}

async fn leaderboard_events(
    State(state): State<AppState>,
) -> Result<Sse<impl tokio_stream::Stream<Item = Result<Event, Infallible>>>, AppError> {
    let initial_event = leaderboard_sse_event(&state)?;
    let stream_state = state.clone();
    let updates = BroadcastStream::new(state.event_bus.subscribe()).filter_map(move |message| {
        let event = match message {
            Ok(event) => event,
            Err(_) => return None,
        };
        if !matches!(
            event,
            AppEvent::ScoreRecorded { .. } | AppEvent::LeaderboardUpdated
        ) {
            return None;
        }
        leaderboard_sse_event(&stream_state).ok().map(Ok)
    });
    let stream = tokio_stream::once(Ok(initial_event)).chain(updates);

    Ok(Sse::new(stream).keep_alive(KeepAlive::default()))
}

fn leaderboard_response(state: &AppState) -> Result<LeaderboardResponse, AppError> {
    let teams = state.repository.leaderboard()?;
    let score_events = state
        .repository
        .list_score_events(ScoreEventListFilter::default())?;
    let updated_at = leaderboard_updated_at(&teams, &score_events);
    Ok(LeaderboardResponse {
        teams: leaderboard_entries_with_score_events(teams, &score_events),
        updated_at,
    })
}

fn leaderboard_sse_event(state: &AppState) -> Result<Event, AppError> {
    let response = leaderboard_response(state)?;
    let data = serde_json::to_string(&response).map_err(|error| {
        AppError::internal(format!("failed to serialize leaderboard event: {error}"))
    })?;
    Ok(Event::default().event("message").data(data))
}

fn leaderboard_score_stats(score_events: &[ScoreEvent]) -> HashMap<TeamId, LeaderboardScoreStats> {
    let mut stats = HashMap::new();
    for event in score_events {
        let entry = stats
            .entry(event.team_id)
            .or_insert_with(LeaderboardScoreStats::default);
        if event.event_type == ScoreEventType::ChallengePass {
            entry.solved_count = entry.solved_count.saturating_add(1);
        }
        entry.last_score_event_at = match entry.last_score_event_at {
            Some(current) => Some(current.max(event.created_at)),
            None => Some(event.created_at),
        };
    }
    stats
}

fn leaderboard_updated_at(teams: &[crate::models::Team], score_events: &[ScoreEvent]) -> Timestamp {
    let mut updated_at = Utc::now();
    for team in teams {
        updated_at = updated_at.max(team.updated_at);
    }
    for event in score_events {
        updated_at = updated_at.max(event.created_at);
    }
    updated_at
}

async fn team_events(
    State(state): State<AppState>,
    user: AuthenticatedUser,
) -> Result<Sse<impl tokio_stream::Stream<Item = Result<Event, Infallible>>>, AppError> {
    let team_id = require_team(&user)?;
    let stream_state = state.clone();
    let stream = BroadcastStream::new(state.event_bus.subscribe()).filter_map(move |message| {
        let event = match message {
            Ok(event) => event,
            Err(_) => return None,
        };
        if !event_visible_to_team(&stream_state, team_id, &event) {
            return None;
        }
        sse_json_event(&event)
    });

    Ok(Sse::new(stream).keep_alive(KeepAlive::default()))
}

async fn challenge_asset(
    State(state): State<AppState>,
    Path(asset_id): Path<String>,
) -> Result<Response, AppError> {
    let asset = state
        .asset_storage
        .get_asset(&asset_id)?
        .ok_or_else(|| AppError::not_found("asset was not found"))?;
    asset_response(asset.metadata.content_type, asset.bytes)
}

async fn result_asset(
    State(state): State<AppState>,
    Path(submission_id_png): Path<String>,
) -> Result<Response, AppError> {
    let submission_id = submission_id_png
        .strip_suffix(".png")
        .ok_or_else(|| AppError::not_found("result asset was not found"))
        .and_then(parse_submission_id)?;
    let submission = state
        .repository
        .get_submission(submission_id)?
        .ok_or_else(|| AppError::not_found("submission was not found"))?;
    let asset_id = submission
        .result_image_asset_id
        .ok_or_else(|| AppError::not_found("result asset was not found"))?;
    let asset = state
        .asset_storage
        .get_asset(&asset_id)?
        .ok_or_else(|| AppError::not_found("result asset was not found"))?;
    asset_response(RESULT_CONTENT_TYPE.to_owned(), asset.bytes)
}

pub(crate) async fn judge_and_store_submission(
    state: &AppState,
    submission: Submission,
) -> Result<Submission, AppError> {
    let result = judge_submission(state, &submission).await;
    match result {
        Ok(result) => {
            let completed = state
                .repository
                .mark_submission_completed(submission.id, result)?;
            state.event_bus.publish(AppEvent::SubmissionUpdated {
                submission_id: completed.id,
            });
            Ok(completed)
        }
        Err(error_message) => {
            let failed = state
                .repository
                .mark_submission_failed(submission.id, error_message)?;
            state.event_bus.publish(AppEvent::SubmissionUpdated {
                submission_id: failed.id,
            });
            Ok(failed)
        }
    }
}

async fn judge_submission(
    state: &AppState,
    submission: &Submission,
) -> Result<CompletedSubmission, String> {
    let program: BlockProgram = serde_json::from_value(submission.block_program.clone())
        .map_err(|error| format_engine_error(EngineError::InvalidJson(error)))?;
    program.validate().map_err(format_engine_error)?;
    let trace = interpret_program(&program).map_err(format_engine_error)?;
    play_trace_for_blackboard(state, submission, &program, &trace).await;
    let png = render_program_png(&program).map_err(format_engine_error)?;
    let asset_id = format!("results/{}.png", submission.id.as_uuid());
    let result_url = format!("/api/v1/assets/results/{}.png", submission.id.as_uuid());
    state
        .asset_storage
        .put_asset(asset_id.clone(), RESULT_CONTENT_TYPE, png)
        .map_err(public_store_error)?;
    let trace = serde_json::to_value(trace).map_err(|error| error.to_string())?;

    Ok(CompletedSubmission {
        trace: Some(trace),
        result_image_asset_id: Some(asset_id),
        result_image_path: None,
        result_image_url: Some(result_url),
    })
}

async fn play_trace_for_blackboard(
    state: &AppState,
    submission: &Submission,
    program: &BlockProgram,
    trace: &crate::engine::ExecutionTrace,
) {
    state.event_bus.publish(AppEvent::JudgingStarted {
        submission_id: submission.id,
        team_id: submission.team_id,
        challenge_id: submission.challenge_id,
        canvas_width: program.canvas_width,
        canvas_height: program.canvas_height,
        step_count: trace.steps.len(),
    });

    for step in &trace.steps {
        state.event_bus.publish(AppEvent::JudgingStep {
            submission_id: submission.id,
            team_id: submission.team_id,
            challenge_id: submission.challenge_id,
            canvas_width: program.canvas_width,
            canvas_height: program.canvas_height,
            step: step.clone(),
            playback_ms: TRACE_STEP_PLAYBACK_MS,
        });
    }

    state.event_bus.publish(AppEvent::JudgingCompleted {
        submission_id: submission.id,
        team_id: submission.team_id,
        challenge_id: submission.challenge_id,
    });
}

async fn play_completed_submission_for_blackboard(
    state: &AppState,
    submission_id: SubmissionId,
) -> Result<(), AppError> {
    let submission = state
        .repository
        .get_submission(submission_id)?
        .ok_or_else(|| AppError::not_found("submission was not found"))?;
    let program: BlockProgram =
        serde_json::from_value(submission.block_program.clone()).map_err(|error| {
            AppError::internal(format!("stored submission program is invalid: {error}"))
        })?;
    let trace_value = submission
        .trace
        .clone()
        .ok_or_else(|| AppError::bad_request("submission does not have a completed trace"))?;
    let trace: crate::engine::ExecutionTrace =
        serde_json::from_value(trace_value).map_err(|error| {
            AppError::internal(format!("stored submission trace is invalid: {error}"))
        })?;

    play_trace_for_blackboard(state, &submission, &program, &trace).await;
    Ok(())
}

fn validated_program_value(value: Value) -> Result<Value, AppError> {
    let program: BlockProgram = serde_json::from_value(value).map_err(|error| {
        AppError::bad_request("block program is invalid")
            .with_details(serde_json::json!({ "reason": error.to_string() }))
    })?;
    program.validate().map_err(engine_app_error)?;
    serde_json::to_value(program).map_err(|error| {
        AppError::internal(format!(
            "failed to serialize validated block program: {error}"
        ))
    })
}

fn event_visible_to_team(state: &AppState, team_id: TeamId, event: &AppEvent) -> bool {
    match event {
        AppEvent::LeaderboardUpdated | AppEvent::BlackboardPlaybackChanged { .. } => false,
        AppEvent::ScoreRecorded { score_event } => score_event.team_id == team_id,
        AppEvent::SubmissionUpdated { submission_id } => state
            .repository
            .get_submission(*submission_id)
            .ok()
            .flatten()
            .is_some_and(|submission| submission.team_id == team_id),
        AppEvent::GameStateChanged { .. } | AppEvent::RoundUpdated { .. } => true,
        AppEvent::JudgingStarted {
            submission_id,
            team_id: event_team_id,
            ..
        }
        | AppEvent::JudgingStep {
            submission_id,
            team_id: event_team_id,
            ..
        }
        | AppEvent::JudgingCompleted {
            submission_id,
            team_id: event_team_id,
            ..
        } => {
            *event_team_id == team_id
                || state
                    .repository
                    .get_submission(*submission_id)
                    .ok()
                    .flatten()
                    .is_some_and(|submission| submission.team_id == team_id)
        }
    }
}

fn sse_json_event(event: &AppEvent) -> Option<Result<Event, Infallible>> {
    serde_json::to_string(event)
        .ok()
        .map(|data| Ok(Event::default().event("message").data(data)))
}

fn asset_response(content_type: String, bytes: Vec<u8>) -> Result<Response, AppError> {
    let mut headers = HeaderMap::new();
    let content_type = HeaderValue::from_str(&content_type)
        .map_err(|_| AppError::internal("stored asset has an invalid content type"))?;
    headers.insert(header::CONTENT_TYPE, content_type);
    Ok((headers, bytes).into_response())
}

fn require_team(user: &AuthenticatedUser) -> Result<TeamId, AppError> {
    if user.role != Role::Team {
        return Err(AppError::forbidden("team authentication required"));
    }
    Uuid::parse_str(&user.subject)
        .map(TeamId::from)
        .map_err(|_| AppError::unauthorized("team token subject is invalid"))
}

fn parse_submission_id(value: &str) -> Result<SubmissionId, AppError> {
    Uuid::parse_str(value)
        .map(SubmissionId::from)
        .map_err(|_| AppError::not_found("result asset was not found"))
}

fn engine_app_error(error: EngineError) -> AppError {
    AppError::bad_request("block program is invalid")
        .with_details(serde_json::json!({ "reason": error.to_string() }))
}

fn format_engine_error(error: EngineError) -> String {
    error.to_string()
}

fn public_store_error(error: crate::state::StoreError) -> String {
    error.to_string()
}
