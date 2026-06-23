use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, RwLock},
};

use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use thiserror::Error;
use tokio::sync::{Mutex, broadcast};

use crate::{
    config::Config,
    engine::TraceStep,
    models::{
        CanvasConfig, Challenge, ChallengeId, ChallengeProgressStatus, ChallengeSet,
        ChallengeSetId, ChallengeSetStatus, ScoreEvent, ScoreEventId, ScoreEventRefs,
        ScoreEventType, Submission, SubmissionId, SubmissionStatus, Team, TeamId,
    },
};

const EVENT_BUS_CAPACITY: usize = 256;
const SUBMISSION_RATE_LIMIT_SECONDS: i64 = 3;

#[derive(Clone)]
pub struct AppState {
    pub config: Arc<Config>,
    pub auth_secret: Arc<str>,
    pub event_bus: EventBus,
    pub judge_lock: Arc<Mutex<()>>,
    pub queue_paused: Arc<RwLock<bool>>,
    pub repository: Arc<dyn Repository>,
    pub asset_storage: InMemoryStorage,
    pub services: AppServices,
}

impl AppState {
    pub fn new(config: Config) -> Self {
        let auth_secret: Arc<str> = Arc::from(config.auth_secret.clone());
        let config = Arc::new(config);
        let repository: Arc<dyn Repository> = Arc::new(InMemoryDatabase::default());
        let asset_storage = InMemoryStorage::default();
        let services =
            AppServices::in_memory_with_handles(repository.clone(), Arc::new(asset_storage.clone()));

        Self {
            config,
            auth_secret,
            event_bus: EventBus::new(EVENT_BUS_CAPACITY),
            judge_lock: Arc::new(Mutex::new(())),
            queue_paused: Arc::new(RwLock::new(false)),
            repository,
            asset_storage,
            services,
        }
    }

    pub fn with_services(mut self, services: AppServices) -> Self {
        self.services = services;
        self
    }

    pub fn is_queue_paused(&self) -> Result<bool, StoreError> {
        self.queue_paused
            .read()
            .map(|paused| *paused)
            .map_err(|_| StoreError::LockUnavailable)
    }

    pub fn set_queue_paused(&self, paused: bool) -> Result<bool, StoreError> {
        let mut guard = self
            .queue_paused
            .write()
            .map_err(|_| StoreError::LockUnavailable)?;
        *guard = paused;
        Ok(paused)
    }
}

#[derive(Clone)]
pub struct EventBus {
    tx: broadcast::Sender<AppEvent>,
}

impl EventBus {
    pub fn new(capacity: usize) -> Self {
        let (tx, _) = broadcast::channel(capacity);
        Self { tx }
    }

    pub fn subscribe(&self) -> broadcast::Receiver<AppEvent> {
        self.tx.subscribe()
    }

    pub fn publish(&self, event: AppEvent) -> usize {
        self.tx.send(event).unwrap_or(0)
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AppEvent {
    LeaderboardUpdated,
    ScoreRecorded {
        score_event: ScoreEvent,
    },
    SubmissionUpdated {
        submission_id: SubmissionId,
    },
    JudgingStarted {
        submission_id: SubmissionId,
        team_id: TeamId,
        challenge_id: ChallengeId,
        canvas_width: u32,
        canvas_height: u32,
        step_count: usize,
    },
    JudgingStep {
        submission_id: SubmissionId,
        team_id: TeamId,
        challenge_id: ChallengeId,
        canvas_width: u32,
        canvas_height: u32,
        step: TraceStep,
        playback_ms: u64,
    },
    JudgingCompleted {
        submission_id: SubmissionId,
        team_id: TeamId,
        challenge_id: ChallengeId,
    },
}

#[derive(Clone)]
pub struct AppServices {
    pub database: Arc<dyn Database>,
    pub storage: Arc<dyn Storage>,
}

impl AppServices {
    pub fn in_memory() -> Self {
        Self::in_memory_with_handles(
            Arc::new(InMemoryDatabase::default()),
            Arc::new(InMemoryStorage::default()),
        )
    }

    pub fn in_memory_with_handles(
        database: Arc<dyn Repository>,
        storage: Arc<dyn Storage>,
    ) -> Self {
        Self {
            database,
            storage,
        }
    }
}

pub trait Database: Send + Sync + 'static {
    fn readiness(&self) -> ServiceReadiness;
}

pub trait Storage: Send + Sync + 'static {
    fn readiness(&self) -> ServiceReadiness;
}

pub trait Repository: Database {
    fn create_team(
        &self,
        name: &str,
        login_code: &str,
        note: Option<String>,
    ) -> Result<Team, StoreError>;
    fn get_team(&self, team_id: TeamId) -> Result<Option<Team>, StoreError>;
    fn team_by_login_code(&self, login_code: &str) -> Result<Option<Team>, StoreError>;
    fn list_teams(&self) -> Result<Vec<Team>, StoreError>;
    fn set_team_enabled(&self, team_id: TeamId, enabled: bool) -> Result<Team, StoreError>;
    fn update_team(&self, team_id: TeamId, update: TeamUpdate) -> Result<Team, StoreError>;

    fn create_challenge_set(
        &self,
        name: &str,
        version: &str,
        status: ChallengeSetStatus,
    ) -> Result<ChallengeSet, StoreError>;
    fn activate_challenge_set(
        &self,
        challenge_set_id: ChallengeSetId,
    ) -> Result<ChallengeSet, StoreError>;
    fn get_challenge_set(
        &self,
        challenge_set_id: ChallengeSetId,
    ) -> Result<Option<ChallengeSet>, StoreError>;
    fn list_challenge_sets(&self) -> Result<Vec<ChallengeSet>, StoreError>;
    fn active_challenge_set(&self) -> Result<Option<ChallengeSet>, StoreError>;
    fn archive_challenge_set(
        &self,
        challenge_set_id: ChallengeSetId,
    ) -> Result<ChallengeSet, StoreError>;

    fn create_challenge(&self, input: NewChallenge) -> Result<Challenge, StoreError>;
    fn get_challenge(&self, challenge_id: ChallengeId) -> Result<Option<Challenge>, StoreError>;
    fn list_challenges(
        &self,
        challenge_set_id: ChallengeSetId,
    ) -> Result<Vec<Challenge>, StoreError>;
    fn list_all_challenges(&self) -> Result<Vec<Challenge>, StoreError>;
    fn update_challenge(
        &self,
        challenge_id: ChallengeId,
        update: ChallengeUpdate,
    ) -> Result<Challenge, StoreError>;
    fn update_challenge_target_image(
        &self,
        challenge_id: ChallengeId,
        update: ChallengeTargetImageUpdate,
    ) -> Result<Challenge, StoreError>;
    fn disable_challenge(&self, challenge_id: ChallengeId) -> Result<Challenge, StoreError>;
    fn reorder_challenges(
        &self,
        reorders: &[ChallengeReorder],
    ) -> Result<Vec<Challenge>, StoreError>;
    fn team_challenge_progress(
        &self,
        team_id: TeamId,
        challenge_id: ChallengeId,
    ) -> Result<TeamChallengeProgress, StoreError>;
    fn challenge_stats(&self, challenge_id: ChallengeId) -> Result<ChallengeStats, StoreError>;

    fn create_submission(
        &self,
        team_id: TeamId,
        challenge_id: ChallengeId,
        block_program: Value,
        retry_of: Option<SubmissionId>,
    ) -> Result<Submission, StoreError>;
    fn submission_rate_limit(
        &self,
        team_id: TeamId,
        now: DateTime<Utc>,
    ) -> Result<RateLimitStatus, StoreError>;
    fn list_queued_running_submissions(&self) -> Result<Vec<Submission>, StoreError>;
    fn queue_position(&self, submission_id: SubmissionId) -> Result<Option<usize>, StoreError>;
    fn cancel_queued_submission(
        &self,
        submission_id: SubmissionId,
    ) -> Result<Submission, StoreError>;
    fn prioritize_submission(
        &self,
        submission_id: SubmissionId,
        priority: i32,
    ) -> Result<Submission, StoreError>;
    fn pop_next_queued_submission(&self) -> Result<Option<Submission>, StoreError>;
    fn mark_submission_running(&self, submission_id: SubmissionId) -> Result<Submission, StoreError>;
    fn mark_submission_completed(
        &self,
        submission_id: SubmissionId,
        result: CompletedSubmission,
    ) -> Result<Submission, StoreError>;
    fn mark_submission_failed(
        &self,
        submission_id: SubmissionId,
        error_message: String,
    ) -> Result<Submission, StoreError>;
    fn get_submission(&self, submission_id: SubmissionId) -> Result<Option<Submission>, StoreError>;
    fn list_submissions(
        &self,
        filter: SubmissionListFilter,
    ) -> Result<Vec<Submission>, StoreError>;

    fn append_score_event(&self, input: ScoreEventInput) -> Result<ScoreEvent, StoreError>;
    fn append_score_events_bulk(
        &self,
        inputs: Vec<ScoreEventInput>,
    ) -> Result<Vec<ScoreEvent>, StoreError>;
    fn list_score_events(
        &self,
        filter: ScoreEventListFilter,
    ) -> Result<Vec<ScoreEvent>, StoreError>;
    fn recalculate_scores_from_events(&self) -> Result<Vec<Team>, StoreError>;
    fn recalculate_challenge_pass_awards(&self) -> Result<Vec<Team>, StoreError>;
    fn leaderboard(&self) -> Result<Vec<Team>, StoreError>;
    fn challenge_progress(
        &self,
        team_id: TeamId,
        challenge_id: ChallengeId,
    ) -> Result<ChallengeProgressStatus, StoreError>;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ServiceReadiness {
    Ok,
    Unavailable(String),
}

impl ServiceReadiness {
    pub fn is_ok(&self) -> bool {
        matches!(self, Self::Ok)
    }

    pub fn label(&self) -> &'static str {
        match self {
            Self::Ok => "ok",
            Self::Unavailable(_) => "unavailable",
        }
    }
}

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum StoreError {
    #[error("store lock is unavailable")]
    LockUnavailable,
    #[error("team login code already exists")]
    DuplicateLoginCode,
    #[error("challenge slug already exists in this set")]
    DuplicateChallengeSlug,
    #[error("challenge pass score event already exists")]
    DuplicateChallengePass,
    #[error("{entity} was not found")]
    NotFound { entity: &'static str },
    #[error("submission is not queued")]
    SubmissionNotQueued,
    #[error("score update overflowed")]
    ScoreOverflow,
    #[error("admin set score event requires a target score")]
    AdminSetRequiresScore,
    #[error("challenge pass score event requires a challenge reference")]
    ChallengePassRequiresChallenge,
    #[error("cannot archive the only active challenge set")]
    CannotArchiveOnlyActive,
}

#[derive(Debug, Clone)]
pub struct NewChallenge {
    pub challenge_set_id: ChallengeSetId,
    pub slug: String,
    pub title: String,
    pub description: String,
    pub target_image_asset_id: Option<String>,
    pub target_image_path: Option<String>,
    pub target_image_url: Option<String>,
    pub points: i32,
    pub pass_threshold: f64,
    pub enabled: bool,
    pub order: i32,
    pub canvas: CanvasConfig,
    pub judge_config: Value,
}

#[derive(Debug, Clone, Default)]
pub struct ChallengeUpdate {
    pub title: Option<String>,
    pub description: Option<String>,
    pub points: Option<i32>,
    pub pass_threshold: Option<f64>,
    pub enabled: Option<bool>,
    pub order: Option<i32>,
}

#[derive(Debug, Clone)]
pub struct ChallengeTargetImageUpdate {
    pub target_image_asset_id: String,
    pub target_image_path: String,
    pub target_image_url: Option<String>,
}

#[derive(Debug, Clone)]
pub struct ChallengeReorder {
    pub challenge_id: ChallengeId,
    pub order: i32,
}

#[derive(Debug, Clone, PartialEq)]
pub struct TeamChallengeProgress {
    pub status: ChallengeProgressStatus,
    pub submission_count: usize,
    pub best_similarity: Option<f64>,
    pub best_submission_id: Option<SubmissionId>,
    pub awarded_points: Option<i32>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ChallengeStats {
    pub submission_count: usize,
    pub solved_count: usize,
    pub best_similarity: Option<f64>,
}

#[derive(Debug, Clone)]
pub struct ScoreEventInput {
    pub team_id: TeamId,
    pub event_type: ScoreEventType,
    pub delta: i32,
    pub score_after: Option<i32>,
    pub refs: ScoreEventRefs,
    pub reason: Option<String>,
    pub created_by: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct SubmissionListFilter {
    pub team_id: Option<TeamId>,
    pub challenge_id: Option<ChallengeId>,
    pub status: Option<SubmissionStatus>,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct ScoreEventListFilter {
    pub team_id: Option<TeamId>,
    pub challenge_id: Option<ChallengeId>,
    #[serde(rename = "type")]
    pub event_type: Option<ScoreEventType>,
}

impl ScoreEventInput {
    pub fn challenge_pass(
        team_id: TeamId,
        challenge_id: ChallengeId,
        submission_id: SubmissionId,
        awarded_points: i32,
    ) -> Self {
        Self {
            team_id,
            event_type: ScoreEventType::ChallengePass,
            delta: awarded_points,
            score_after: None,
            refs: ScoreEventRefs {
                challenge_id: Some(challenge_id),
                submission_id: Some(submission_id),
            },
            reason: None,
            created_by: None,
        }
    }

    pub fn admin_set(
        team_id: TeamId,
        score_after: i32,
        reason: impl Into<String>,
        created_by: impl Into<String>,
    ) -> Self {
        Self {
            team_id,
            event_type: ScoreEventType::AdminSet,
            delta: 0,
            score_after: Some(score_after),
            refs: ScoreEventRefs::default(),
            reason: Some(reason.into()),
            created_by: Some(created_by.into()),
        }
    }

    pub fn admin_add(
        team_id: TeamId,
        delta: i32,
        reason: impl Into<String>,
        created_by: impl Into<String>,
    ) -> Self {
        Self {
            team_id,
            event_type: ScoreEventType::AdminAdd,
            delta,
            score_after: None,
            refs: ScoreEventRefs::default(),
            reason: Some(reason.into()),
            created_by: Some(created_by.into()),
        }
    }

    pub fn admin_subtract(
        team_id: TeamId,
        amount: i32,
        reason: impl Into<String>,
        created_by: impl Into<String>,
    ) -> Self {
        Self {
            team_id,
            event_type: ScoreEventType::AdminSubtract,
            delta: amount.saturating_abs().saturating_neg(),
            score_after: None,
            refs: ScoreEventRefs::default(),
            reason: Some(reason.into()),
            created_by: Some(created_by.into()),
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct TeamUpdate {
    pub name: Option<String>,
    pub login_code: Option<String>,
    pub enabled: Option<bool>,
    pub note: Option<Option<String>>,
}

#[derive(Debug, Clone)]
pub struct CompletedSubmission {
    pub trace: Option<Value>,
    pub similarity: Option<f64>,
    pub passed: bool,
    pub judge_score: Option<f64>,
    pub awarded_points: i32,
    pub result_image_asset_id: Option<String>,
    pub result_image_path: Option<String>,
    pub result_image_url: Option<String>,
}

#[derive(Debug, Default, Clone)]
pub struct InMemoryDatabase {
    inner: Arc<RwLock<StoreInner>>,
}

impl Repository for InMemoryDatabase {
    fn create_team(
        &self,
        name: &str,
        login_code: &str,
        note: Option<String>,
    ) -> Result<Team, StoreError> {
        InMemoryDatabase::create_team(self, name.to_owned(), login_code.to_owned(), note)
    }

    fn get_team(&self, team_id: TeamId) -> Result<Option<Team>, StoreError> {
        InMemoryDatabase::get_team(self, team_id)
    }

    fn team_by_login_code(&self, login_code: &str) -> Result<Option<Team>, StoreError> {
        InMemoryDatabase::team_by_login_code(self, login_code)
    }

    fn list_teams(&self) -> Result<Vec<Team>, StoreError> {
        InMemoryDatabase::list_teams(self)
    }

    fn set_team_enabled(&self, team_id: TeamId, enabled: bool) -> Result<Team, StoreError> {
        InMemoryDatabase::set_team_enabled(self, team_id, enabled)
    }

    fn update_team(&self, team_id: TeamId, update: TeamUpdate) -> Result<Team, StoreError> {
        InMemoryDatabase::update_team(self, team_id, update)
    }

    fn create_challenge_set(
        &self,
        name: &str,
        version: &str,
        status: ChallengeSetStatus,
    ) -> Result<ChallengeSet, StoreError> {
        InMemoryDatabase::create_challenge_set(self, name.to_owned(), version.to_owned(), status)
    }

    fn activate_challenge_set(
        &self,
        challenge_set_id: ChallengeSetId,
    ) -> Result<ChallengeSet, StoreError> {
        InMemoryDatabase::activate_challenge_set(self, challenge_set_id)
    }

    fn get_challenge_set(
        &self,
        challenge_set_id: ChallengeSetId,
    ) -> Result<Option<ChallengeSet>, StoreError> {
        InMemoryDatabase::get_challenge_set(self, challenge_set_id)
    }

    fn list_challenge_sets(&self) -> Result<Vec<ChallengeSet>, StoreError> {
        InMemoryDatabase::list_challenge_sets(self)
    }

    fn active_challenge_set(&self) -> Result<Option<ChallengeSet>, StoreError> {
        InMemoryDatabase::active_challenge_set(self)
    }

    fn archive_challenge_set(
        &self,
        challenge_set_id: ChallengeSetId,
    ) -> Result<ChallengeSet, StoreError> {
        InMemoryDatabase::archive_challenge_set(self, challenge_set_id)
    }

    fn create_challenge(&self, input: NewChallenge) -> Result<Challenge, StoreError> {
        InMemoryDatabase::create_challenge(self, input)
    }

    fn get_challenge(&self, challenge_id: ChallengeId) -> Result<Option<Challenge>, StoreError> {
        InMemoryDatabase::get_challenge(self, challenge_id)
    }

    fn list_challenges(
        &self,
        challenge_set_id: ChallengeSetId,
    ) -> Result<Vec<Challenge>, StoreError> {
        InMemoryDatabase::list_challenges(self, challenge_set_id)
    }

    fn list_all_challenges(&self) -> Result<Vec<Challenge>, StoreError> {
        InMemoryDatabase::list_all_challenges(self)
    }

    fn update_challenge(
        &self,
        challenge_id: ChallengeId,
        update: ChallengeUpdate,
    ) -> Result<Challenge, StoreError> {
        InMemoryDatabase::update_challenge(self, challenge_id, update)
    }

    fn update_challenge_target_image(
        &self,
        challenge_id: ChallengeId,
        update: ChallengeTargetImageUpdate,
    ) -> Result<Challenge, StoreError> {
        InMemoryDatabase::update_challenge_target_image(self, challenge_id, update)
    }

    fn disable_challenge(&self, challenge_id: ChallengeId) -> Result<Challenge, StoreError> {
        InMemoryDatabase::disable_challenge(self, challenge_id)
    }

    fn reorder_challenges(
        &self,
        reorders: &[ChallengeReorder],
    ) -> Result<Vec<Challenge>, StoreError> {
        InMemoryDatabase::reorder_challenges(self, reorders)
    }

    fn team_challenge_progress(
        &self,
        team_id: TeamId,
        challenge_id: ChallengeId,
    ) -> Result<TeamChallengeProgress, StoreError> {
        InMemoryDatabase::team_challenge_progress(self, team_id, challenge_id)
    }

    fn challenge_stats(&self, challenge_id: ChallengeId) -> Result<ChallengeStats, StoreError> {
        InMemoryDatabase::challenge_stats(self, challenge_id)
    }

    fn create_submission(
        &self,
        team_id: TeamId,
        challenge_id: ChallengeId,
        block_program: Value,
        retry_of: Option<SubmissionId>,
    ) -> Result<Submission, StoreError> {
        InMemoryDatabase::create_submission(self, team_id, challenge_id, block_program, retry_of)
    }

    fn submission_rate_limit(
        &self,
        team_id: TeamId,
        now: DateTime<Utc>,
    ) -> Result<RateLimitStatus, StoreError> {
        InMemoryDatabase::submission_rate_limit(self, team_id, now)
    }

    fn list_queued_running_submissions(&self) -> Result<Vec<Submission>, StoreError> {
        InMemoryDatabase::list_queued_running_submissions(self)
    }

    fn queue_position(&self, submission_id: SubmissionId) -> Result<Option<usize>, StoreError> {
        InMemoryDatabase::queue_position(self, submission_id)
    }

    fn cancel_queued_submission(
        &self,
        submission_id: SubmissionId,
    ) -> Result<Submission, StoreError> {
        InMemoryDatabase::cancel_queued_submission(self, submission_id)
    }

    fn prioritize_submission(
        &self,
        submission_id: SubmissionId,
        priority: i32,
    ) -> Result<Submission, StoreError> {
        InMemoryDatabase::prioritize_submission(self, submission_id, priority)
    }

    fn pop_next_queued_submission(&self) -> Result<Option<Submission>, StoreError> {
        InMemoryDatabase::pop_next_queued_submission(self)
    }

    fn mark_submission_running(&self, submission_id: SubmissionId) -> Result<Submission, StoreError> {
        InMemoryDatabase::mark_submission_running(self, submission_id)
    }

    fn mark_submission_completed(
        &self,
        submission_id: SubmissionId,
        result: CompletedSubmission,
    ) -> Result<Submission, StoreError> {
        InMemoryDatabase::mark_submission_completed(self, submission_id, result)
    }

    fn mark_submission_failed(
        &self,
        submission_id: SubmissionId,
        error_message: String,
    ) -> Result<Submission, StoreError> {
        InMemoryDatabase::mark_submission_failed(self, submission_id, error_message)
    }

    fn get_submission(&self, submission_id: SubmissionId) -> Result<Option<Submission>, StoreError> {
        InMemoryDatabase::get_submission(self, submission_id)
    }

    fn list_submissions(
        &self,
        filter: SubmissionListFilter,
    ) -> Result<Vec<Submission>, StoreError> {
        InMemoryDatabase::list_submissions(self, filter)
    }

    fn append_score_event(&self, input: ScoreEventInput) -> Result<ScoreEvent, StoreError> {
        InMemoryDatabase::append_score_event(self, input)
    }

    fn append_score_events_bulk(
        &self,
        inputs: Vec<ScoreEventInput>,
    ) -> Result<Vec<ScoreEvent>, StoreError> {
        InMemoryDatabase::append_score_events_bulk(self, inputs)
    }

    fn list_score_events(
        &self,
        filter: ScoreEventListFilter,
    ) -> Result<Vec<ScoreEvent>, StoreError> {
        InMemoryDatabase::list_score_events(self, filter)
    }

    fn recalculate_scores_from_events(&self) -> Result<Vec<Team>, StoreError> {
        InMemoryDatabase::recalculate_scores_from_events(self)
    }

    fn recalculate_challenge_pass_awards(&self) -> Result<Vec<Team>, StoreError> {
        InMemoryDatabase::recalculate_challenge_pass_awards(self)
    }

    fn leaderboard(&self) -> Result<Vec<Team>, StoreError> {
        InMemoryDatabase::leaderboard(self)
    }

    fn challenge_progress(
        &self,
        team_id: TeamId,
        challenge_id: ChallengeId,
    ) -> Result<ChallengeProgressStatus, StoreError> {
        InMemoryDatabase::challenge_progress(self, team_id, challenge_id)
    }
}

impl InMemoryDatabase {
    pub fn create_team(
        &self,
        name: impl Into<String>,
        login_code: impl Into<String>,
        note: Option<String>,
    ) -> Result<Team, StoreError> {
        let mut inner = self.write_inner()?;
        let login_code = login_code.into();
        if inner.login_codes.contains_key(&login_code) {
            return Err(StoreError::DuplicateLoginCode);
        }

        let now = Utc::now();
        let team = Team {
            id: TeamId::new(),
            name: name.into(),
            login_code: login_code.clone(),
            enabled: true,
            note,
            total_score: 0,
            created_at: now,
            updated_at: now,
        };
        inner.login_codes.insert(login_code, team.id);
        inner.teams.insert(team.id, team.clone());
        Ok(team)
    }

    pub fn get_team(&self, team_id: TeamId) -> Result<Option<Team>, StoreError> {
        Ok(self.read_inner()?.teams.get(&team_id).cloned())
    }

    pub fn team_by_login_code(&self, login_code: &str) -> Result<Option<Team>, StoreError> {
        let inner = self.read_inner()?;
        let Some(team_id) = inner.login_codes.get(login_code) else {
            return Ok(None);
        };
        Ok(inner.teams.get(team_id).cloned())
    }

    pub fn list_teams(&self) -> Result<Vec<Team>, StoreError> {
        let mut teams: Vec<_> = self.read_inner()?.teams.values().cloned().collect();
        teams.sort_by(|left, right| {
            left.created_at
                .cmp(&right.created_at)
                .then(left.id.cmp(&right.id))
        });
        Ok(teams)
    }

    pub fn set_team_enabled(&self, team_id: TeamId, enabled: bool) -> Result<Team, StoreError> {
        let mut inner = self.write_inner()?;
        let team = inner
            .teams
            .get_mut(&team_id)
            .ok_or(StoreError::NotFound { entity: "team" })?;
        team.enabled = enabled;
        team.updated_at = Utc::now();
        Ok(team.clone())
    }

    pub fn update_team(&self, team_id: TeamId, update: TeamUpdate) -> Result<Team, StoreError> {
        let mut inner = self.write_inner()?;
        let old_login_code = inner
            .teams
            .get(&team_id)
            .ok_or(StoreError::NotFound { entity: "team" })?
            .login_code
            .clone();

        if let Some(login_code) = update.login_code.as_ref() {
            let existing_team_id = inner.login_codes.get(login_code).copied();
            if existing_team_id.is_some_and(|existing_team_id| existing_team_id != team_id) {
                return Err(StoreError::DuplicateLoginCode);
            }
        }

        let new_login_code = update
            .login_code
            .filter(|login_code| login_code != &old_login_code);

        let team = inner
            .teams
            .get_mut(&team_id)
            .ok_or(StoreError::NotFound { entity: "team" })?;
        if let Some(name) = update.name {
            team.name = name;
        }
        if let Some(enabled) = update.enabled {
            team.enabled = enabled;
        }
        if let Some(note) = update.note {
            team.note = note;
        }
        if let Some(login_code) = new_login_code.as_ref() {
            team.login_code.clone_from(login_code);
        }

        team.updated_at = Utc::now();
        let team = team.clone();
        if let Some(login_code) = new_login_code {
            inner.login_codes.remove(&old_login_code);
            inner.login_codes.insert(login_code, team_id);
        }

        Ok(team)
    }

    pub fn create_challenge_set(
        &self,
        name: impl Into<String>,
        version: impl Into<String>,
        status: ChallengeSetStatus,
    ) -> Result<ChallengeSet, StoreError> {
        let mut inner = self.write_inner()?;
        let now = Utc::now();
        if status == ChallengeSetStatus::Active {
            archive_active_sets(&mut inner, now, None);
        }
        let challenge_set = ChallengeSet {
            id: ChallengeSetId::new(),
            name: name.into(),
            version: version.into(),
            status,
            created_at: now,
            updated_at: now,
        };
        inner
            .challenge_sets
            .insert(challenge_set.id, challenge_set.clone());
        Ok(challenge_set)
    }

    pub fn activate_challenge_set(
        &self,
        challenge_set_id: ChallengeSetId,
    ) -> Result<ChallengeSet, StoreError> {
        let mut inner = self.write_inner()?;
        if !inner.challenge_sets.contains_key(&challenge_set_id) {
            return Err(StoreError::NotFound {
                entity: "challenge_set",
            });
        }

        let now = Utc::now();
        archive_active_sets(&mut inner, now, Some(challenge_set_id));
        let challenge_set =
            inner
                .challenge_sets
                .get_mut(&challenge_set_id)
                .ok_or(StoreError::NotFound {
                    entity: "challenge_set",
                })?;
        challenge_set.status = ChallengeSetStatus::Active;
        challenge_set.updated_at = now;
        Ok(challenge_set.clone())
    }

    pub fn get_challenge_set(
        &self,
        challenge_set_id: ChallengeSetId,
    ) -> Result<Option<ChallengeSet>, StoreError> {
        Ok(self
            .read_inner()?
            .challenge_sets
            .get(&challenge_set_id)
            .cloned())
    }

    pub fn list_challenge_sets(&self) -> Result<Vec<ChallengeSet>, StoreError> {
        let mut challenge_sets: Vec<_> = self
            .read_inner()?
            .challenge_sets
            .values()
            .cloned()
            .collect();
        challenge_sets.sort_by(|left, right| {
            left.created_at
                .cmp(&right.created_at)
                .then(left.id.cmp(&right.id))
        });
        Ok(challenge_sets)
    }

    pub fn active_challenge_set(&self) -> Result<Option<ChallengeSet>, StoreError> {
        Ok(self
            .read_inner()?
            .challenge_sets
            .values()
            .find(|challenge_set| challenge_set.status == ChallengeSetStatus::Active)
            .cloned())
    }

    pub fn archive_challenge_set(
        &self,
        challenge_set_id: ChallengeSetId,
    ) -> Result<ChallengeSet, StoreError> {
        let mut inner = self.write_inner()?;
        let active_count = inner
            .challenge_sets
            .values()
            .filter(|challenge_set| challenge_set.status == ChallengeSetStatus::Active)
            .count();
        let challenge_set =
            inner
                .challenge_sets
                .get_mut(&challenge_set_id)
                .ok_or(StoreError::NotFound {
                    entity: "challenge_set",
                })?;
        if challenge_set.status == ChallengeSetStatus::Active && active_count <= 1 {
            return Err(StoreError::CannotArchiveOnlyActive);
        }

        challenge_set.status = ChallengeSetStatus::Archived;
        challenge_set.updated_at = Utc::now();
        Ok(challenge_set.clone())
    }

    pub fn create_challenge(&self, input: NewChallenge) -> Result<Challenge, StoreError> {
        let mut inner = self.write_inner()?;
        if !inner.challenge_sets.contains_key(&input.challenge_set_id) {
            return Err(StoreError::NotFound {
                entity: "challenge_set",
            });
        }

        let slug_key = (input.challenge_set_id, input.slug.clone());
        if inner.challenge_slugs.contains_key(&slug_key) {
            return Err(StoreError::DuplicateChallengeSlug);
        }

        let now = Utc::now();
        let challenge = Challenge {
            id: ChallengeId::new(),
            challenge_set_id: input.challenge_set_id,
            slug: input.slug,
            title: input.title,
            description: input.description,
            target_image_asset_id: input.target_image_asset_id,
            target_image_path: input.target_image_path,
            target_image_url: input.target_image_url,
            points: input.points,
            pass_threshold: input.pass_threshold,
            enabled: input.enabled,
            order: input.order,
            canvas: input.canvas,
            judge_config: input.judge_config,
            created_at: now,
            updated_at: now,
        };
        inner.challenge_slugs.insert(slug_key, challenge.id);
        inner.challenges.insert(challenge.id, challenge.clone());
        Ok(challenge)
    }

    pub fn get_challenge(
        &self,
        challenge_id: ChallengeId,
    ) -> Result<Option<Challenge>, StoreError> {
        Ok(self.read_inner()?.challenges.get(&challenge_id).cloned())
    }

    pub fn list_challenges(
        &self,
        challenge_set_id: ChallengeSetId,
    ) -> Result<Vec<Challenge>, StoreError> {
        let mut challenges: Vec<_> = self
            .read_inner()?
            .challenges
            .values()
            .filter(|challenge| challenge.challenge_set_id == challenge_set_id)
            .cloned()
            .collect();
        challenges.sort_by(|left, right| {
            left.order
                .cmp(&right.order)
                .then(left.slug.cmp(&right.slug))
        });
        Ok(challenges)
    }

    pub fn list_all_challenges(&self) -> Result<Vec<Challenge>, StoreError> {
        let mut challenges: Vec<_> = self.read_inner()?.challenges.values().cloned().collect();
        sort_challenges(&mut challenges);
        Ok(challenges)
    }

    pub fn update_challenge(
        &self,
        challenge_id: ChallengeId,
        update: ChallengeUpdate,
    ) -> Result<Challenge, StoreError> {
        let mut inner = self.write_inner()?;
        let challenge = inner
            .challenges
            .get_mut(&challenge_id)
            .ok_or(StoreError::NotFound {
                entity: "challenge",
            })?;
        if let Some(title) = update.title {
            challenge.title = title;
        }
        if let Some(description) = update.description {
            challenge.description = description;
        }
        if let Some(points) = update.points {
            challenge.points = points;
        }
        if let Some(pass_threshold) = update.pass_threshold {
            challenge.pass_threshold = pass_threshold;
        }
        if let Some(enabled) = update.enabled {
            challenge.enabled = enabled;
        }
        if let Some(order) = update.order {
            challenge.order = order;
        }
        challenge.updated_at = Utc::now();
        Ok(challenge.clone())
    }

    pub fn update_challenge_target_image(
        &self,
        challenge_id: ChallengeId,
        update: ChallengeTargetImageUpdate,
    ) -> Result<Challenge, StoreError> {
        let mut inner = self.write_inner()?;
        let challenge = inner
            .challenges
            .get_mut(&challenge_id)
            .ok_or(StoreError::NotFound {
                entity: "challenge",
            })?;
        challenge.target_image_asset_id = Some(update.target_image_asset_id);
        challenge.target_image_path = Some(update.target_image_path);
        challenge.target_image_url = update.target_image_url;
        challenge.updated_at = Utc::now();
        Ok(challenge.clone())
    }

    pub fn disable_challenge(&self, challenge_id: ChallengeId) -> Result<Challenge, StoreError> {
        self.update_challenge(
            challenge_id,
            ChallengeUpdate {
                enabled: Some(false),
                ..ChallengeUpdate::default()
            },
        )
    }

    pub fn reorder_challenges(
        &self,
        reorders: &[ChallengeReorder],
    ) -> Result<Vec<Challenge>, StoreError> {
        let mut inner = self.write_inner()?;
        for reorder in reorders {
            if !inner.challenges.contains_key(&reorder.challenge_id) {
                return Err(StoreError::NotFound {
                    entity: "challenge",
                });
            }
        }

        let now = Utc::now();
        let mut updated = Vec::with_capacity(reorders.len());
        for reorder in reorders {
            let challenge =
                inner
                    .challenges
                    .get_mut(&reorder.challenge_id)
                    .ok_or(StoreError::NotFound {
                        entity: "challenge",
                    })?;
            challenge.order = reorder.order;
            challenge.updated_at = now;
            updated.push(challenge.clone());
        }
        sort_challenges(&mut updated);
        Ok(updated)
    }

    pub fn team_challenge_progress(
        &self,
        team_id: TeamId,
        challenge_id: ChallengeId,
    ) -> Result<TeamChallengeProgress, StoreError> {
        let inner = self.read_inner()?;
        if !inner.teams.contains_key(&team_id) {
            return Err(StoreError::NotFound { entity: "team" });
        }
        if !inner.challenges.contains_key(&challenge_id) {
            return Err(StoreError::NotFound {
                entity: "challenge",
            });
        }

        let mut submission_count = 0_usize;
        let mut best_similarity = None;
        let mut best_submission_id = None;
        let mut awarded_points = None;
        for submission in inner.submissions.values().filter(|submission| {
            submission.team_id == team_id && submission.challenge_id == challenge_id
        }) {
            submission_count = submission_count.saturating_add(1);
            if let Some(points) = submission.awarded_points {
                awarded_points =
                    Some(awarded_points.map_or(points, |current: i32| current.max(points)));
            }
            let Some(similarity) = submission.similarity else {
                continue;
            };
            if best_similarity.is_none_or(|current| similarity > current) {
                best_similarity = Some(similarity);
                best_submission_id = Some(submission.id);
            }
        }

        let solved = inner.score_events.iter().any(|event| {
            event.team_id == team_id
                && event.event_type == ScoreEventType::ChallengePass
                && event.refs.challenge_id == Some(challenge_id)
        });
        let status = if solved {
            ChallengeProgressStatus::Solved
        } else if submission_count > 0 {
            ChallengeProgressStatus::Attempted
        } else {
            ChallengeProgressStatus::NotStarted
        };

        Ok(TeamChallengeProgress {
            status,
            submission_count,
            best_similarity,
            best_submission_id,
            awarded_points,
        })
    }

    pub fn challenge_stats(&self, challenge_id: ChallengeId) -> Result<ChallengeStats, StoreError> {
        let inner = self.read_inner()?;
        if !inner.challenges.contains_key(&challenge_id) {
            return Err(StoreError::NotFound {
                entity: "challenge",
            });
        }

        let submission_count = inner
            .submissions
            .values()
            .filter(|submission| submission.challenge_id == challenge_id)
            .count();
        let best_similarity = inner
            .submissions
            .values()
            .filter(|submission| submission.challenge_id == challenge_id)
            .filter_map(|submission| submission.similarity)
            .max_by(f64::total_cmp);
        let solved_count = inner
            .score_events
            .iter()
            .filter(|event| {
                event.event_type == ScoreEventType::ChallengePass
                    && event.refs.challenge_id == Some(challenge_id)
            })
            .map(|event| event.team_id)
            .collect::<std::collections::HashSet<_>>()
            .len();

        Ok(ChallengeStats {
            submission_count,
            solved_count,
            best_similarity,
        })
    }

    pub fn create_submission(
        &self,
        team_id: TeamId,
        challenge_id: ChallengeId,
        block_program: Value,
        retry_of: Option<SubmissionId>,
    ) -> Result<Submission, StoreError> {
        let mut inner = self.write_inner()?;
        require_team_and_challenge(&inner, team_id, challenge_id)?;

        let attempt_count = inner
            .submissions
            .values()
            .filter(|submission| {
                submission.team_id == team_id && submission.challenge_id == challenge_id
            })
            .count();
        let attempt_no = u32::try_from(attempt_count)
            .ok()
            .and_then(|count| count.checked_add(1))
            .unwrap_or(u32::MAX);
        let queue_order = inner.next_queue_order;
        inner.next_queue_order = inner.next_queue_order.saturating_add(1);

        let now = Utc::now();
        let submission = Submission {
            id: SubmissionId::new(),
            team_id,
            challenge_id,
            attempt_no,
            block_program,
            status: SubmissionStatus::Queued,
            queue_order,
            priority: 0,
            result_image_asset_id: None,
            result_image_path: None,
            result_image_url: None,
            trace: None,
            similarity: None,
            passed: None,
            judge_score: None,
            awarded_points: None,
            error_message: None,
            retry_of,
            created_at: now,
            updated_at: now,
            started_at: None,
            completed_at: None,
            cancelled_at: None,
        };
        inner.last_submission_at.insert(team_id, now);
        inner.submissions.insert(submission.id, submission.clone());
        Ok(submission)
    }

    pub fn submission_rate_limit(
        &self,
        team_id: TeamId,
        now: DateTime<Utc>,
    ) -> Result<RateLimitStatus, StoreError> {
        let inner = self.read_inner()?;
        let Some(last_submission_at) = inner.last_submission_at.get(&team_id).copied() else {
            return Ok(RateLimitStatus::Allowed);
        };
        let allowed_at = last_submission_at + Duration::seconds(SUBMISSION_RATE_LIMIT_SECONDS);
        if now >= allowed_at {
            Ok(RateLimitStatus::Allowed)
        } else {
            Ok(RateLimitStatus::Limited { allowed_at })
        }
    }

    pub fn list_queued_running_submissions(&self) -> Result<Vec<Submission>, StoreError> {
        let mut submissions: Vec<_> = self
            .read_inner()?
            .submissions
            .values()
            .filter(|submission| {
                matches!(
                    submission.status,
                    SubmissionStatus::Queued | SubmissionStatus::Running
                )
            })
            .cloned()
            .collect();
        sort_submissions_for_queue(&mut submissions);
        Ok(submissions)
    }

    pub fn queue_position(&self, submission_id: SubmissionId) -> Result<Option<usize>, StoreError> {
        let mut submissions: Vec<_> = self
            .read_inner()?
            .submissions
            .values()
            .filter(|submission| submission.status == SubmissionStatus::Queued)
            .cloned()
            .collect();
        sort_submissions_for_queue(&mut submissions);
        Ok(submissions
            .iter()
            .position(|submission| submission.id == submission_id)
            .map(|index| index.saturating_add(1)))
    }

    pub fn cancel_queued_submission(
        &self,
        submission_id: SubmissionId,
    ) -> Result<Submission, StoreError> {
        let mut inner = self.write_inner()?;
        let submission = inner
            .submissions
            .get_mut(&submission_id)
            .ok_or(StoreError::NotFound {
                entity: "submission",
            })?;
        if submission.status != SubmissionStatus::Queued {
            return Err(StoreError::SubmissionNotQueued);
        }
        let now = Utc::now();
        submission.status = SubmissionStatus::Cancelled;
        submission.updated_at = now;
        submission.cancelled_at = Some(now);
        Ok(submission.clone())
    }

    pub fn prioritize_submission(
        &self,
        submission_id: SubmissionId,
        priority: i32,
    ) -> Result<Submission, StoreError> {
        let mut inner = self.write_inner()?;
        let submission = inner
            .submissions
            .get_mut(&submission_id)
            .ok_or(StoreError::NotFound {
                entity: "submission",
            })?;
        if submission.status != SubmissionStatus::Queued {
            return Err(StoreError::SubmissionNotQueued);
        }
        submission.priority = priority;
        submission.updated_at = Utc::now();
        Ok(submission.clone())
    }

    pub fn pop_next_queued_submission(&self) -> Result<Option<Submission>, StoreError> {
        let mut inner = self.write_inner()?;
        let next_id = inner
            .submissions
            .values()
            .filter(|submission| submission.status == SubmissionStatus::Queued)
            .max_by(|left, right| {
                left.priority
                    .cmp(&right.priority)
                    .then_with(|| right.queue_order.cmp(&left.queue_order))
            })
            .map(|submission| submission.id);
        let Some(submission_id) = next_id else {
            return Ok(None);
        };

        let now = Utc::now();
        let submission = inner
            .submissions
            .get_mut(&submission_id)
            .ok_or(StoreError::NotFound {
                entity: "submission",
            })?;
        submission.status = SubmissionStatus::Running;
        submission.started_at = Some(now);
        submission.updated_at = now;
        Ok(Some(submission.clone()))
    }

    pub fn mark_submission_running(
        &self,
        submission_id: SubmissionId,
    ) -> Result<Submission, StoreError> {
        let mut inner = self.write_inner()?;
        let submission = inner
            .submissions
            .get_mut(&submission_id)
            .ok_or(StoreError::NotFound {
                entity: "submission",
            })?;
        let now = Utc::now();
        submission.status = SubmissionStatus::Running;
        submission.started_at = submission.started_at.or(Some(now));
        submission.updated_at = now;
        Ok(submission.clone())
    }

    pub fn mark_submission_completed(
        &self,
        submission_id: SubmissionId,
        result: CompletedSubmission,
    ) -> Result<Submission, StoreError> {
        let mut inner = self.write_inner()?;
        let submission = inner
            .submissions
            .get_mut(&submission_id)
            .ok_or(StoreError::NotFound {
                entity: "submission",
            })?;
        let now = Utc::now();
        submission.status = SubmissionStatus::Completed;
        submission.trace = result.trace;
        submission.similarity = result.similarity;
        submission.passed = Some(result.passed);
        submission.judge_score = result.judge_score;
        submission.awarded_points = Some(result.awarded_points);
        submission.result_image_asset_id = result.result_image_asset_id;
        submission.result_image_path = result.result_image_path;
        submission.result_image_url = result.result_image_url;
        submission.updated_at = now;
        submission.completed_at = Some(now);
        Ok(submission.clone())
    }

    pub fn mark_submission_failed(
        &self,
        submission_id: SubmissionId,
        error_message: impl Into<String>,
    ) -> Result<Submission, StoreError> {
        let mut inner = self.write_inner()?;
        let submission = inner
            .submissions
            .get_mut(&submission_id)
            .ok_or(StoreError::NotFound {
                entity: "submission",
            })?;
        let now = Utc::now();
        submission.status = SubmissionStatus::Failed;
        submission.error_message = Some(error_message.into());
        submission.updated_at = now;
        submission.completed_at = Some(now);
        Ok(submission.clone())
    }

    pub fn get_submission(
        &self,
        submission_id: SubmissionId,
    ) -> Result<Option<Submission>, StoreError> {
        Ok(self.read_inner()?.submissions.get(&submission_id).cloned())
    }

    pub fn list_submissions(
        &self,
        filter: SubmissionListFilter,
    ) -> Result<Vec<Submission>, StoreError> {
        let mut submissions: Vec<_> = self
            .read_inner()?
            .submissions
            .values()
            .filter(|submission| {
                filter
                    .team_id
                    .is_none_or(|team_id| submission.team_id == team_id)
                    && filter
                        .challenge_id
                        .is_none_or(|challenge_id| submission.challenge_id == challenge_id)
                    && filter
                        .status
                        .as_ref()
                        .is_none_or(|status| submission.status == *status)
            })
            .cloned()
            .collect();
        submissions.sort_by(|left, right| {
            right
                .created_at
                .cmp(&left.created_at)
                .then(left.queue_order.cmp(&right.queue_order))
        });
        Ok(submissions)
    }

    pub fn append_score_event(&self, input: ScoreEventInput) -> Result<ScoreEvent, StoreError> {
        let mut inner = self.write_inner()?;
        if !inner.teams.contains_key(&input.team_id) {
            return Err(StoreError::NotFound { entity: "team" });
        }
        if input.event_type == ScoreEventType::ChallengePass {
            let challenge_id = input
                .refs
                .challenge_id
                .ok_or(StoreError::ChallengePassRequiresChallenge)?;
            if inner.score_events.iter().any(|event| {
                event.team_id == input.team_id
                    && event.event_type == ScoreEventType::ChallengePass
                    && event.refs.challenge_id == Some(challenge_id)
            }) {
                return Err(StoreError::DuplicateChallengePass);
            }
        }

        let team = inner
            .teams
            .get_mut(&input.team_id)
            .ok_or(StoreError::NotFound { entity: "team" })?;
        let score_before = team.total_score;
        let (delta, score_after) = if input.event_type == ScoreEventType::AdminSet {
            let score_after = input.score_after.ok_or(StoreError::AdminSetRequiresScore)?;
            (
                score_after
                    .checked_sub(score_before)
                    .ok_or(StoreError::ScoreOverflow)?,
                score_after,
            )
        } else {
            let score_after = score_before
                .checked_add(input.delta)
                .ok_or(StoreError::ScoreOverflow)?;
            (input.delta, score_after)
        };

        let now = Utc::now();
        team.total_score = score_after;
        team.updated_at = now;
        let event = ScoreEvent {
            id: ScoreEventId::new(),
            team_id: input.team_id,
            event_type: input.event_type,
            score_before,
            score_after,
            delta,
            refs: input.refs,
            reason: input.reason,
            created_by: input.created_by,
            created_at: now,
        };
        inner.score_events.push(event.clone());
        Ok(event)
    }

    pub fn append_score_events_bulk(
        &self,
        inputs: Vec<ScoreEventInput>,
    ) -> Result<Vec<ScoreEvent>, StoreError> {
        let mut inner = self.write_inner()?;
        let mut pending_events = Vec::with_capacity(inputs.len());
        let mut scores: HashMap<TeamId, i32> = inner
            .teams
            .iter()
            .map(|(team_id, team)| (*team_id, team.total_score))
            .collect();
        let mut challenge_passes: HashSet<(TeamId, ChallengeId)> = inner
            .score_events
            .iter()
            .filter_map(|event| {
                if event.event_type == ScoreEventType::ChallengePass {
                    event
                        .refs
                        .challenge_id
                        .map(|challenge_id| (event.team_id, challenge_id))
                } else {
                    None
                }
            })
            .collect();

        for input in inputs {
            let Some(score_before) = scores.get(&input.team_id).copied() else {
                return Err(StoreError::NotFound { entity: "team" });
            };
            if input.event_type == ScoreEventType::ChallengePass {
                let challenge_id = input
                    .refs
                    .challenge_id
                    .ok_or(StoreError::ChallengePassRequiresChallenge)?;
                if !challenge_passes.insert((input.team_id, challenge_id)) {
                    return Err(StoreError::DuplicateChallengePass);
                }
            }

            let (delta, score_after) = if input.event_type == ScoreEventType::AdminSet {
                let score_after = input.score_after.ok_or(StoreError::AdminSetRequiresScore)?;
                (
                    score_after
                        .checked_sub(score_before)
                        .ok_or(StoreError::ScoreOverflow)?,
                    score_after,
                )
            } else {
                let score_after = score_before
                    .checked_add(input.delta)
                    .ok_or(StoreError::ScoreOverflow)?;
                (input.delta, score_after)
            };
            scores.insert(input.team_id, score_after);
            pending_events.push(ScoreEvent {
                id: ScoreEventId::new(),
                team_id: input.team_id,
                event_type: input.event_type,
                score_before,
                score_after,
                delta,
                refs: input.refs,
                reason: input.reason,
                created_by: input.created_by,
                created_at: Utc::now(),
            });
        }

        let now = Utc::now();
        for (team_id, score) in scores {
            let team = inner
                .teams
                .get_mut(&team_id)
                .ok_or(StoreError::NotFound { entity: "team" })?;
            team.total_score = score;
            team.updated_at = now;
        }
        inner.score_events.extend(pending_events.iter().cloned());
        Ok(pending_events)
    }

    pub fn list_score_events(
        &self,
        filter: ScoreEventListFilter,
    ) -> Result<Vec<ScoreEvent>, StoreError> {
        Ok(self
            .read_inner()?
            .score_events
            .iter()
            .filter(|event| {
                filter
                    .team_id
                    .is_none_or(|team_id| event.team_id == team_id)
                    && filter
                        .challenge_id
                        .is_none_or(|challenge_id| event.refs.challenge_id == Some(challenge_id))
                    && filter
                        .event_type
                        .as_ref()
                        .is_none_or(|event_type| event.event_type == *event_type)
            })
            .cloned()
            .collect())
    }

    pub fn recalculate_scores_from_events(&self) -> Result<Vec<Team>, StoreError> {
        let mut inner = self.write_inner()?;
        let mut scores: HashMap<TeamId, i32> =
            inner.teams.keys().map(|team_id| (*team_id, 0)).collect();
        for event in &inner.score_events {
            let Some(score) = scores.get_mut(&event.team_id) else {
                continue;
            };
            *score = if event.event_type == ScoreEventType::AdminSet {
                event.score_after
            } else {
                score
                    .checked_add(event.delta)
                    .ok_or(StoreError::ScoreOverflow)?
            };
        }

        update_team_scores(&mut inner, scores)
    }

    pub fn recalculate_challenge_pass_awards(&self) -> Result<Vec<Team>, StoreError> {
        let mut inner = self.write_inner()?;
        let challenge_points: HashMap<ChallengeId, i32> = inner
            .challenges
            .iter()
            .map(|(challenge_id, challenge)| (*challenge_id, challenge.points))
            .collect();
        let mut scores: HashMap<TeamId, i32> =
            inner.teams.keys().map(|team_id| (*team_id, 0)).collect();

        for event in &mut inner.score_events {
            let Some(score_before) = scores.get(&event.team_id).copied() else {
                continue;
            };
            event.score_before = score_before;
            if event.event_type == ScoreEventType::ChallengePass {
                if let Some(challenge_id) = event.refs.challenge_id
                    && let Some(points) = challenge_points.get(&challenge_id)
                {
                    event.delta = *points;
                }
                event.score_after = event
                    .score_before
                    .checked_add(event.delta)
                    .ok_or(StoreError::ScoreOverflow)?;
            } else if event.event_type == ScoreEventType::AdminSet {
                event.delta = event
                    .score_after
                    .checked_sub(event.score_before)
                    .ok_or(StoreError::ScoreOverflow)?;
            } else {
                event.score_after = event
                    .score_before
                    .checked_add(event.delta)
                    .ok_or(StoreError::ScoreOverflow)?;
            }
            scores.insert(event.team_id, event.score_after);
        }

        update_team_scores(&mut inner, scores)
    }

    pub fn leaderboard(&self) -> Result<Vec<Team>, StoreError> {
        let mut teams: Vec<_> = self.read_inner()?.teams.values().cloned().collect();
        teams.sort_by(|left, right| {
            right
                .total_score
                .cmp(&left.total_score)
                .then(left.created_at.cmp(&right.created_at))
                .then(left.id.cmp(&right.id))
        });
        Ok(teams)
    }

    pub fn challenge_progress(
        &self,
        team_id: TeamId,
        challenge_id: ChallengeId,
    ) -> Result<ChallengeProgressStatus, StoreError> {
        let inner = self.read_inner()?;
        let solved = inner.score_events.iter().any(|event| {
            event.team_id == team_id
                && event.event_type == ScoreEventType::ChallengePass
                && event.refs.challenge_id == Some(challenge_id)
        });
        if solved {
            return Ok(ChallengeProgressStatus::Solved);
        }
        let attempted = inner.submissions.values().any(|submission| {
            submission.team_id == team_id && submission.challenge_id == challenge_id
        });
        if attempted {
            Ok(ChallengeProgressStatus::Attempted)
        } else {
            Ok(ChallengeProgressStatus::NotStarted)
        }
    }

    fn read_inner(&self) -> Result<std::sync::RwLockReadGuard<'_, StoreInner>, StoreError> {
        self.inner.read().map_err(|_| StoreError::LockUnavailable)
    }

    fn write_inner(&self) -> Result<std::sync::RwLockWriteGuard<'_, StoreInner>, StoreError> {
        self.inner.write().map_err(|_| StoreError::LockUnavailable)
    }
}

impl Database for InMemoryDatabase {
    fn readiness(&self) -> ServiceReadiness {
        match self.inner.read() {
            Ok(_) => ServiceReadiness::Ok,
            Err(_) => ServiceReadiness::Unavailable("database lock is unavailable".to_owned()),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RateLimitStatus {
    Allowed,
    Limited { allowed_at: DateTime<Utc> },
}

#[derive(Debug, Default)]
struct StoreInner {
    teams: HashMap<TeamId, Team>,
    login_codes: HashMap<String, TeamId>,
    challenge_sets: HashMap<ChallengeSetId, ChallengeSet>,
    challenges: HashMap<ChallengeId, Challenge>,
    challenge_slugs: HashMap<(ChallengeSetId, String), ChallengeId>,
    submissions: HashMap<SubmissionId, Submission>,
    score_events: Vec<ScoreEvent>,
    last_submission_at: HashMap<TeamId, DateTime<Utc>>,
    next_queue_order: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredAssetMetadata {
    pub id: String,
    pub content_type: String,
    pub byte_len: usize,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone)]
pub struct StoredAsset {
    pub metadata: StoredAssetMetadata,
    pub bytes: Vec<u8>,
}

#[derive(Debug, Default, Clone)]
pub struct InMemoryStorage {
    assets: Arc<RwLock<HashMap<String, StoredAsset>>>,
}

impl InMemoryStorage {
    pub fn put_asset(
        &self,
        id: impl Into<String>,
        content_type: impl Into<String>,
        bytes: Vec<u8>,
    ) -> Result<StoredAssetMetadata, StoreError> {
        let mut assets = self
            .assets
            .write()
            .map_err(|_| StoreError::LockUnavailable)?;
        let metadata = StoredAssetMetadata {
            id: id.into(),
            content_type: content_type.into(),
            byte_len: bytes.len(),
            created_at: Utc::now(),
        };
        assets.insert(
            metadata.id.clone(),
            StoredAsset {
                metadata: metadata.clone(),
                bytes,
            },
        );
        Ok(metadata)
    }

    pub fn get_asset(&self, id: &str) -> Result<Option<StoredAsset>, StoreError> {
        Ok(self
            .assets
            .read()
            .map_err(|_| StoreError::LockUnavailable)?
            .get(id)
            .cloned())
    }

    pub fn get_asset_metadata(&self, id: &str) -> Result<Option<StoredAssetMetadata>, StoreError> {
        Ok(self
            .assets
            .read()
            .map_err(|_| StoreError::LockUnavailable)?
            .get(id)
            .map(|asset| asset.metadata.clone()))
    }
}

impl Storage for InMemoryStorage {
    fn readiness(&self) -> ServiceReadiness {
        match self.assets.read() {
            Ok(_) => ServiceReadiness::Ok,
            Err(_) => ServiceReadiness::Unavailable("storage lock is unavailable".to_owned()),
        }
    }
}

fn archive_active_sets(inner: &mut StoreInner, now: DateTime<Utc>, except: Option<ChallengeSetId>) {
    for challenge_set in inner.challenge_sets.values_mut() {
        if challenge_set.status == ChallengeSetStatus::Active && Some(challenge_set.id) != except {
            challenge_set.status = ChallengeSetStatus::Archived;
            challenge_set.updated_at = now;
        }
    }
}

fn require_team_and_challenge(
    inner: &StoreInner,
    team_id: TeamId,
    challenge_id: ChallengeId,
) -> Result<(), StoreError> {
    if !inner.teams.contains_key(&team_id) {
        return Err(StoreError::NotFound { entity: "team" });
    }
    if !inner.challenges.contains_key(&challenge_id) {
        return Err(StoreError::NotFound {
            entity: "challenge",
        });
    }
    Ok(())
}

fn sort_submissions_for_queue(submissions: &mut [Submission]) {
    submissions.sort_by(|left, right| {
        right
            .priority
            .cmp(&left.priority)
            .then(left.queue_order.cmp(&right.queue_order))
    });
}

fn update_team_scores(
    inner: &mut StoreInner,
    scores: HashMap<TeamId, i32>,
) -> Result<Vec<Team>, StoreError> {
    let now = Utc::now();
    for (team_id, score) in scores {
        let team = inner
            .teams
            .get_mut(&team_id)
            .ok_or(StoreError::NotFound { entity: "team" })?;
        team.total_score = score;
        team.updated_at = now;
    }

    let mut teams: Vec<_> = inner.teams.values().cloned().collect();
    teams.sort_by(|left, right| {
        right
            .total_score
            .cmp(&left.total_score)
            .then(left.created_at.cmp(&right.created_at))
            .then(left.id.cmp(&right.id))
    });
    Ok(teams)
}

fn sort_challenges(challenges: &mut [Challenge]) {
    challenges.sort_by(|left, right| {
        left.challenge_set_id
            .cmp(&right.challenge_set_id)
            .then(left.order.cmp(&right.order))
            .then(left.slug.cmp(&right.slug))
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn login_code_must_be_unique() {
        let store = InMemoryDatabase::default();

        let first = store.create_team("one", "same-code", None);
        let second = store.create_team("two", "same-code", None);

        assert!(first.is_ok());
        assert_eq!(second, Err(StoreError::DuplicateLoginCode));
    }

    #[test]
    fn activating_challenge_set_archives_previous_active_set() {
        let store = InMemoryDatabase::default();
        let first = store
            .create_challenge_set("first", "v1", ChallengeSetStatus::Active)
            .expect("first set should create");
        let second = store
            .create_challenge_set("second", "v2", ChallengeSetStatus::Draft)
            .expect("second set should create");

        store
            .activate_challenge_set(second.id)
            .expect("second set should activate");

        let first = store
            .get_challenge_set(first.id)
            .expect("store should read")
            .expect("first set should exist");
        let second = store
            .get_challenge_set(second.id)
            .expect("store should read")
            .expect("second set should exist");
        assert_eq!(first.status, ChallengeSetStatus::Archived);
        assert_eq!(second.status, ChallengeSetStatus::Active);
    }

    #[test]
    fn challenge_pass_score_event_is_unique_for_team_and_challenge() {
        let store = InMemoryDatabase::default();
        let (team, challenge) = team_and_challenge(&store);
        let submission = store
            .create_submission(team.id, challenge.id, json!({ "blocks": [] }), None)
            .expect("submission should create");

        let first = store.append_score_event(ScoreEventInput::challenge_pass(
            team.id,
            challenge.id,
            submission.id,
            challenge.points,
        ));
        let duplicate = store.append_score_event(ScoreEventInput::challenge_pass(
            team.id,
            challenge.id,
            submission.id,
            challenge.points,
        ));

        assert!(first.is_ok());
        assert_eq!(duplicate, Err(StoreError::DuplicateChallengePass));
        let team = store
            .get_team(team.id)
            .expect("store should read")
            .expect("team should exist");
        assert_eq!(team.total_score, challenge.points);
    }

    #[test]
    fn admin_set_score_event_uses_delta_from_previous_score() {
        let store = InMemoryDatabase::default();
        let team = store
            .create_team("team", "code", None)
            .expect("team should create");
        store
            .append_score_event(ScoreEventInput::admin_add(team.id, 10, "bonus", "admin"))
            .expect("admin add should append");

        let event = store
            .append_score_event(ScoreEventInput::admin_set(
                team.id,
                3,
                "correction",
                "admin",
            ))
            .expect("admin set should append");

        assert_eq!(event.score_before, 10);
        assert_eq!(event.score_after, 3);
        assert_eq!(event.delta, -7);
        let team = store
            .get_team(team.id)
            .expect("store should read")
            .expect("team should exist");
        assert_eq!(team.total_score, 3);
    }

    #[test]
    fn queue_order_prioritize_and_cancel_behave_as_expected() {
        let store = InMemoryDatabase::default();
        let (team, challenge) = team_and_challenge(&store);
        let first = store
            .create_submission(team.id, challenge.id, json!({ "n": 1 }), None)
            .expect("first submission should create");
        let second = store
            .create_submission(team.id, challenge.id, json!({ "n": 2 }), None)
            .expect("second submission should create");
        let third = store
            .create_submission(team.id, challenge.id, json!({ "n": 3 }), None)
            .expect("third submission should create");

        assert!(first.queue_order < second.queue_order);
        assert!(second.queue_order < third.queue_order);

        store
            .prioritize_submission(third.id, 10)
            .expect("third submission should prioritize");
        store
            .cancel_queued_submission(second.id)
            .expect("second submission should cancel");

        let next = store
            .pop_next_queued_submission()
            .expect("queue should pop")
            .expect("queued submission should exist");
        assert_eq!(next.id, third.id);
        assert_eq!(next.status, SubmissionStatus::Running);

        let queued_running = store
            .list_queued_running_submissions()
            .expect("queue should list");
        assert_eq!(queued_running.len(), 2);
        assert_eq!(queued_running[0].id, third.id);
        assert_eq!(queued_running[1].id, first.id);

        let cancelled = store
            .get_submission(second.id)
            .expect("store should read")
            .expect("submission should exist");
        assert_eq!(cancelled.status, SubmissionStatus::Cancelled);
    }

    fn team_and_challenge(store: &InMemoryDatabase) -> (Team, Challenge) {
        let team = store
            .create_team("team", "code", None)
            .expect("team should create");
        let challenge_set = store
            .create_challenge_set("set", "v1", ChallengeSetStatus::Active)
            .expect("challenge set should create");
        let challenge = store
            .create_challenge(NewChallenge {
                challenge_set_id: challenge_set.id,
                slug: "slug".to_owned(),
                title: "Title".to_owned(),
                description: "Description".to_owned(),
                target_image_asset_id: None,
                target_image_path: None,
                target_image_url: None,
                points: 100,
                pass_threshold: 0.9,
                enabled: true,
                order: 1,
                canvas: CanvasConfig::default(),
                judge_config: json!({ "timeout_ms": 1000 }),
            })
            .expect("challenge should create");
        (team, challenge)
    }
}
