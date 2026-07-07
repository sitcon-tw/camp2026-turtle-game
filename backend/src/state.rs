use std::{
    collections::{HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
    sync::{Arc, RwLock},
};

use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use thiserror::Error;
use tokio::sync::{Mutex, broadcast, mpsc};

use crate::{
    config::Config,
    engine::TraceStep,
    models::{
        CanvasConfig, Challenge, ChallengeId, ChallengeProgressStatus, ChallengeSet,
        ChallengeSetId, ChallengeSetStatus, GamePhase, GameStateView, PublicVote, PublicVoteChoice,
        Round, RoundId, RoundResultEntry, ScoreEvent, ScoreEventId, ScoreEventRefs, ScoreEventType,
        Submission, SubmissionId, SubmissionStatus, Team, TeamId, TeamNomination,
        TeamSelectionVote, Timestamp,
    },
};

const EVENT_BUS_CAPACITY: usize = 256;
const SUBMISSION_RATE_LIMIT_SECONDS: i64 = 3;

#[derive(Clone)]
pub struct AppState {
    pub config: Arc<Config>,
    pub auth_secret: Arc<str>,
    pub event_bus: EventBus,
    pub blackboard: BlackboardStore,
    pub blackboard_signaling: BlackboardSignalHub,
    pub judge_lock: Arc<Mutex<()>>,
    pub queue_paused: Arc<RwLock<bool>>,
    pub repository: Arc<dyn Repository>,
    pub asset_storage: InMemoryStorage,
    pub services: AppServices,
    pub game: GameStore,
}

impl AppState {
    pub fn new(config: Config) -> Self {
        let auth_secret: Arc<str> = Arc::from(config.auth_secret.clone());
        let data_dir = config.data_dir.clone();
        let config = Arc::new(config);
        let (repository, asset_storage, game): (Arc<dyn Repository>, InMemoryStorage, GameStore) =
            if let Some(data_dir) = data_dir {
                (
                    Arc::new(InMemoryDatabase::from_file(data_dir.join("store.json"))),
                    InMemoryStorage::from_file(data_dir.join("assets.json")),
                    GameStore::from_file(data_dir.join("game.json")),
                )
            } else {
                (
                    Arc::new(InMemoryDatabase::default()),
                    InMemoryStorage::default(),
                    GameStore::default(),
                )
            };
        let services = AppServices::in_memory_with_handles(
            repository.clone(),
            Arc::new(asset_storage.clone()),
        );

        Self {
            config,
            auth_secret,
            event_bus: EventBus::new(EVENT_BUS_CAPACITY),
            blackboard: BlackboardStore::default(),
            blackboard_signaling: BlackboardSignalHub::default(),
            judge_lock: Arc::new(Mutex::new(())),
            queue_paused: Arc::new(RwLock::new(false)),
            repository,
            asset_storage,
            services,
            game,
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

#[derive(Clone, Default)]
pub struct BlackboardSignalHub {
    inner: Arc<Mutex<BlackboardSignalHubInner>>,
}

#[derive(Default)]
struct BlackboardSignalHubInner {
    teams: HashMap<String, BlackboardTeamSignalEndpoint>,
    viewers: HashMap<String, BlackboardViewerSignalEndpoint>,
}

struct BlackboardTeamSignalEndpoint {
    connection_id: String,
    sender: mpsc::UnboundedSender<String>,
}

struct BlackboardViewerSignalEndpoint {
    session_id: String,
    kind: BlackboardViewerKind,
    sender: mpsc::UnboundedSender<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BlackboardViewerKind {
    Public,
    AdminPreview,
}

impl BlackboardViewerKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Public => "public",
            Self::AdminPreview => "admin_preview",
        }
    }
}

impl BlackboardSignalHub {
    pub async fn register_team(
        &self,
        session_id: String,
        connection_id: String,
        sender: mpsc::UnboundedSender<String>,
    ) {
        let mut inner = self.inner.lock().await;
        inner.teams.insert(
            session_id,
            BlackboardTeamSignalEndpoint {
                connection_id,
                sender,
            },
        );
    }

    pub async fn unregister_team(&self, session_id: &str, connection_id: &str) {
        let mut inner = self.inner.lock().await;
        if !inner
            .teams
            .get(session_id)
            .is_some_and(|endpoint| endpoint.connection_id == connection_id)
        {
            return;
        }
        inner.teams.remove(session_id);
        let viewer_ids: Vec<_> = inner
            .viewers
            .iter()
            .filter_map(|(viewer_id, viewer)| {
                (viewer.session_id == session_id).then(|| viewer_id.clone())
            })
            .collect();
        for viewer_id in viewer_ids {
            if let Some(viewer) = inner.viewers.remove(&viewer_id) {
                let _ = viewer
                    .sender
                    .send(r#"{"type":"webrtc_stream_closed"}"#.to_owned());
            }
        }
    }

    pub async fn register_viewer(
        &self,
        session_id: String,
        viewer_id: String,
        kind: BlackboardViewerKind,
        target_fps: u8,
        sender: mpsc::UnboundedSender<String>,
    ) -> bool {
        let mut inner = self.inner.lock().await;
        let Some(team) = inner.teams.get(&session_id) else {
            return false;
        };
        let _ = team.sender.send(format!(
            r#"{{"type":"webrtc_viewer_joined","viewer_id":"{viewer_id}","viewer_kind":"{}","target_fps":{target_fps}}}"#,
            kind.as_str()
        ));
        inner.viewers.insert(
            viewer_id,
            BlackboardViewerSignalEndpoint {
                session_id,
                kind,
                sender,
            },
        );
        true
    }

    pub async fn unregister_viewer(&self, viewer_id: &str) {
        let mut inner = self.inner.lock().await;
        let Some(viewer) = inner.viewers.remove(viewer_id) else {
            return;
        };
        if let Some(team) = inner.teams.get(&viewer.session_id) {
            let _ = team.sender.send(format!(
                r#"{{"type":"webrtc_viewer_left","viewer_id":"{viewer_id}","viewer_kind":"{}"}}"#,
                viewer.kind.as_str()
            ));
        }
    }

    pub async fn send_to_team(&self, session_id: &str, payload: String) -> bool {
        let inner = self.inner.lock().await;
        inner
            .teams
            .get(session_id)
            .is_some_and(|team| team.sender.send(payload).is_ok())
    }

    pub async fn send_to_viewer(&self, viewer_id: &str, payload: String) -> bool {
        let inner = self.inner.lock().await;
        inner
            .viewers
            .get(viewer_id)
            .is_some_and(|viewer| viewer.sender.send(payload).is_ok())
    }

    pub async fn close_public_viewers_except(&self, selected_session_id: Option<&str>) {
        let mut inner = self.inner.lock().await;
        let viewer_ids: Vec<_> = inner
            .viewers
            .iter()
            .filter_map(|(viewer_id, viewer)| {
                (viewer.kind == BlackboardViewerKind::Public
                    && selected_session_id != Some(viewer.session_id.as_str()))
                .then(|| viewer_id.clone())
            })
            .collect();
        for viewer_id in viewer_ids {
            if let Some(viewer) = inner.viewers.remove(&viewer_id) {
                let _ = viewer
                    .sender
                    .send(r#"{"type":"webrtc_stream_closed"}"#.to_owned());
                if let Some(team) = inner.teams.get(&viewer.session_id) {
                    let _ = team.sender.send(format!(
                        r#"{{"type":"webrtc_viewer_left","viewer_id":"{viewer_id}","viewer_kind":"{}"}}"#,
                        viewer.kind.as_str()
                    ));
                }
            }
        }
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
    BlackboardPlaybackChanged {
        submission_id: Option<SubmissionId>,
    },
    BlackboardDisplayChanged {
        display: BlackboardDisplay,
    },
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
    GameStateChanged {
        version: i64,
    },
    RoundUpdated {
        round_id: RoundId,
        version: i64,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BlackboardDisplayMode {
    Submission,
    Stream,
}

impl Default for BlackboardDisplayMode {
    fn default() -> Self {
        Self::Submission
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct BlackboardDisplay {
    pub mode: BlackboardDisplayMode,
    pub selected_submission_id: Option<SubmissionId>,
    pub selected_stream_session_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct BlackboardStreamSessionView {
    pub session_id: String,
    pub team_id: TeamId,
    pub device_id: String,
    pub label: String,
    pub connected: bool,
    pub last_seen_at: Timestamp,
}

#[derive(Debug, Clone)]
struct BlackboardStreamSession {
    session_id: String,
    team_id: TeamId,
    device_id: String,
    label: String,
    active_connection_id: String,
    connected: bool,
    last_seen_at: Timestamp,
}

#[derive(Clone, Default)]
pub struct BlackboardStore {
    display: Arc<RwLock<BlackboardDisplay>>,
    stream_sessions: Arc<RwLock<HashMap<String, BlackboardStreamSession>>>,
    invalidated_stream_session_ids: Arc<RwLock<HashSet<String>>>,
}

impl BlackboardStore {
    pub fn selected_submission_id(&self) -> Result<Option<SubmissionId>, StoreError> {
        self.display
            .read()
            .map(|display| display.selected_submission_id)
            .map_err(|_| StoreError::LockUnavailable)
    }

    pub fn display(&self) -> Result<BlackboardDisplay, StoreError> {
        self.display
            .read()
            .map(|display| display.clone())
            .map_err(|_| StoreError::LockUnavailable)
    }

    pub fn set_display(&self, display: BlackboardDisplay) -> Result<BlackboardDisplay, StoreError> {
        let mut guard = self
            .display
            .write()
            .map_err(|_| StoreError::LockUnavailable)?;
        *guard = display;
        Ok(guard.clone())
    }

    pub fn reset_display(&self) -> Result<BlackboardDisplay, StoreError> {
        self.set_display(BlackboardDisplay::default())
    }

    pub fn set_selected_submission_id(
        &self,
        submission_id: Option<SubmissionId>,
    ) -> Result<Option<SubmissionId>, StoreError> {
        let mut display = self
            .display
            .write()
            .map_err(|_| StoreError::LockUnavailable)?;
        display.mode = BlackboardDisplayMode::Submission;
        display.selected_submission_id = submission_id;
        display.selected_stream_session_id = None;
        Ok(display.selected_submission_id)
    }

    pub fn register_stream_session(
        &self,
        session_id: String,
        team_id: TeamId,
        device_id: String,
        connection_id: String,
    ) -> Result<BlackboardStreamSessionView, StoreError> {
        let now = Utc::now();
        let invalidated_session_ids = self
            .invalidated_stream_session_ids
            .read()
            .map_err(|_| StoreError::LockUnavailable)?;
        if invalidated_session_ids.contains(&session_id) {
            return Err(StoreError::InvalidatedStreamSession);
        }
        let mut sessions = self
            .stream_sessions
            .write()
            .map_err(|_| StoreError::LockUnavailable)?;
        let label = sessions
            .get(&session_id)
            .map(|session| session.label.clone())
            .unwrap_or_else(|| {
                let team_session_count = sessions
                    .values()
                    .filter(|session| session.team_id == team_id)
                    .count()
                    .saturating_add(1);
                format!("Session {team_session_count}")
            });
        let session =
            sessions
                .entry(session_id.clone())
                .or_insert_with(|| BlackboardStreamSession {
                    session_id,
                    team_id,
                    device_id: device_id.clone(),
                    label,
                    active_connection_id: connection_id.clone(),
                    connected: false,
                    last_seen_at: now,
                });
        session.team_id = team_id;
        session.device_id = device_id;
        session.active_connection_id = connection_id;
        session.connected = true;
        session.last_seen_at = now;
        Ok(self.session_view(session))
    }

    pub fn disconnect_stream_session(
        &self,
        session_id: &str,
        connection_id: &str,
    ) -> Result<bool, StoreError> {
        let mut sessions = self
            .stream_sessions
            .write()
            .map_err(|_| StoreError::LockUnavailable)?;
        if let Some(session) = sessions.get_mut(session_id) {
            if session.active_connection_id != connection_id {
                return Ok(false);
            }
            session.connected = false;
            session.last_seen_at = Utc::now();
            return Ok(true);
        }
        Ok(false)
    }

    pub fn expire_disconnected_stream_session(
        &self,
        session_id: &str,
        connection_id: &str,
    ) -> Result<bool, StoreError> {
        let mut invalidated_session_ids = self
            .invalidated_stream_session_ids
            .write()
            .map_err(|_| StoreError::LockUnavailable)?;
        let mut sessions = self
            .stream_sessions
            .write()
            .map_err(|_| StoreError::LockUnavailable)?;
        let Some(session) = sessions.get(session_id) else {
            return Ok(false);
        };
        if session.connected || session.active_connection_id != connection_id {
            return Ok(false);
        }
        sessions.remove(session_id);
        invalidated_session_ids.insert(session_id.to_owned());
        let mut display = self
            .display
            .write()
            .map_err(|_| StoreError::LockUnavailable)?;
        if display
            .selected_stream_session_id
            .as_deref()
            .is_some_and(|selected| selected == session_id)
        {
            *display = BlackboardDisplay::default();
        }
        Ok(true)
    }

    pub fn stream_sessions(&self) -> Result<Vec<BlackboardStreamSessionView>, StoreError> {
        let sessions = self
            .stream_sessions
            .read()
            .map_err(|_| StoreError::LockUnavailable)?;
        let mut views: Vec<_> = sessions
            .values()
            .map(|session| self.session_view(session))
            .collect();
        views.sort_by(|left, right| {
            left.team_id
                .cmp(&right.team_id)
                .then_with(|| left.label.cmp(&right.label))
                .then_with(|| left.session_id.cmp(&right.session_id))
        });
        Ok(views)
    }

    pub fn stream_session(
        &self,
        session_id: &str,
    ) -> Result<Option<BlackboardStreamSessionView>, StoreError> {
        let sessions = self
            .stream_sessions
            .read()
            .map_err(|_| StoreError::LockUnavailable)?;
        Ok(sessions
            .get(session_id)
            .map(|session| self.session_view(session)))
    }

    fn session_view(&self, session: &BlackboardStreamSession) -> BlackboardStreamSessionView {
        BlackboardStreamSessionView {
            session_id: session.session_id.clone(),
            team_id: session.team_id,
            device_id: session.device_id.clone(),
            label: session.label.clone(),
            connected: session.connected,
            last_seen_at: session.last_seen_at,
        }
    }
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
        Self { database, storage }
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
    fn mark_submission_running(
        &self,
        submission_id: SubmissionId,
    ) -> Result<Submission, StoreError>;
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
    fn get_submission(&self, submission_id: SubmissionId)
    -> Result<Option<Submission>, StoreError>;
    fn list_submissions(&self, filter: SubmissionListFilter)
    -> Result<Vec<Submission>, StoreError>;

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

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum GameError {
    #[error("game store lock is unavailable")]
    LockUnavailable,
    #[error("challenge was not found")]
    ChallengeNotFound,
    #[error("team was not found")]
    TeamNotFound,
    #[error("round is not active")]
    NoActiveRound,
    #[error("game phase does not allow this action")]
    InvalidPhase,
    #[error("phase deadline has passed")]
    DeadlinePassed,
    #[error("submission was not found")]
    SubmissionNotFound,
    #[error("submission does not belong to the current round")]
    SubmissionNotInRound,
    #[error("submission belongs to another team")]
    SubmissionTeamMismatch,
    #[error("public vote choices are invalid")]
    InvalidPublicVote,
    #[error("team nomination was not found")]
    NominationNotFound,
}

#[derive(Debug, Clone)]
pub struct GameSnapshot {
    pub state: GameStateView,
    pub round: Option<Round>,
    pub challenge: Option<Challenge>,
    pub round_submissions: Vec<Submission>,
    pub my_submissions: Vec<Submission>,
    pub nominations: Vec<TeamNomination>,
    pub my_team_selection_vote: Option<TeamSelectionVote>,
    pub my_public_vote: Option<PublicVote>,
    pub public_vote_counts: Vec<PublicVoteCount>,
    pub results: Vec<RoundResultEntry>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PublicVoteCount {
    pub target_team_id: TeamId,
    pub target_submission_id: SubmissionId,
    pub vote_count: usize,
}

#[derive(Debug, Clone)]
pub struct StartRoundInput {
    pub challenge_id: ChallengeId,
    pub submission_seconds: i64,
    pub public_votes_per_team: u8,
    pub created_by: Option<String>,
}

#[derive(Debug, Default, Clone)]
pub struct GameStore {
    inner: Arc<RwLock<GameInner>>,
    persistence_path: Option<Arc<PathBuf>>,
}

impl GameStore {
    pub fn from_file(path: PathBuf) -> Self {
        let inner = read_json::<PersistedGameInner>(&path)
            .map(GameInner::from)
            .unwrap_or_default();
        Self {
            inner: Arc::new(RwLock::new(inner)),
            persistence_path: Some(Arc::new(path)),
        }
    }

    pub fn snapshot(
        &self,
        repository: &dyn Repository,
        team_id: Option<TeamId>,
    ) -> Result<GameSnapshot, GameError> {
        let inner = self.read_inner()?;
        let state = inner.view(Utc::now());
        let round = inner.current_round();
        let challenge = state
            .current_challenge_id
            .and_then(|challenge_id| repository.get_challenge(challenge_id).ok().flatten());
        let round_submissions = state
            .current_round_id
            .map(|round_id| inner.submissions_for_round(repository, round_id))
            .unwrap_or_default();
        let my_submissions = team_id
            .map(|team_id| {
                round_submissions
                    .iter()
                    .filter(|submission| submission.team_id == team_id)
                    .cloned()
                    .collect()
            })
            .unwrap_or_default();
        let nominations = state
            .current_round_id
            .map(|round_id| inner.nominations_for_round(round_id))
            .unwrap_or_default();
        let my_team_selection_vote = match (state.current_round_id, team_id) {
            (Some(round_id), Some(team_id)) => inner
                .team_selection_votes
                .values()
                .find(|vote| vote.round_id == round_id && vote.team_id == team_id)
                .cloned(),
            _ => None,
        };
        let my_public_vote = match (state.current_round_id, team_id) {
            (Some(round_id), Some(team_id)) => {
                inner.public_votes.get(&(round_id, team_id)).cloned()
            }
            _ => None,
        };
        let results = state
            .current_round_id
            .and_then(|round_id| inner.results.get(&round_id).cloned())
            .unwrap_or_default();
        let public_vote_counts = state
            .current_round_id
            .map(|round_id| inner.public_vote_counts_for_round(round_id))
            .unwrap_or_default();
        Ok(GameSnapshot {
            state,
            round,
            challenge,
            round_submissions,
            my_submissions,
            nominations,
            my_team_selection_vote,
            my_public_vote,
            public_vote_counts,
            results,
        })
    }

    pub fn start_round(
        &self,
        repository: &dyn Repository,
        input: StartRoundInput,
    ) -> Result<GameStateView, GameError> {
        let challenge = repository
            .get_challenge(input.challenge_id)
            .map_err(|_| GameError::ChallengeNotFound)?
            .ok_or(GameError::ChallengeNotFound)?;
        if !challenge.enabled {
            return Err(GameError::ChallengeNotFound);
        }
        let mut inner = self.write_inner()?;
        let now = Utc::now();
        let round = Round {
            id: RoundId::new(),
            challenge_id: input.challenge_id,
            started_at: now,
            submission_ends_at: now + Duration::seconds(input.submission_seconds.max(1)),
            team_selection_ends_at: None,
            public_voting_ends_at: None,
            completed_at: None,
        };
        inner.current_round_id = Some(round.id);
        inner.current_challenge_id = Some(input.challenge_id);
        inner.phase = GamePhase::SubmissionOpen;
        inner.phase_started_at = now;
        inner.phase_ends_at = Some(round.submission_ends_at);
        inner.public_votes_per_team = input.public_votes_per_team.max(1);
        inner.updated_at = now;
        inner.updated_by = input.created_by;
        inner.version = inner.version.saturating_add(1);
        inner.rounds.insert(round.id, round);
        let view = inner.view(now);
        self.persist_inner(&inner)?;
        Ok(view)
    }

    pub fn update_timer(
        &self,
        phase_ends_at: DateTime<Utc>,
        updated_by: Option<String>,
    ) -> Result<GameStateView, GameError> {
        let mut inner = self.write_inner()?;
        if inner.phase == GamePhase::Idle {
            return Err(GameError::NoActiveRound);
        }
        let now = Utc::now();
        inner.phase_ends_at = Some(phase_ends_at);
        let phase = inner.phase;
        if let Some(round_id) = inner.current_round_id
            && let Some(round) = inner.rounds.get_mut(&round_id)
        {
            match phase {
                GamePhase::SubmissionOpen => round.submission_ends_at = phase_ends_at,
                GamePhase::TeamSelection => round.team_selection_ends_at = Some(phase_ends_at),
                GamePhase::PublicVoting => round.public_voting_ends_at = Some(phase_ends_at),
                _ => {}
            }
        }
        inner.updated_at = now;
        inner.updated_by = updated_by;
        inner.version = inner.version.saturating_add(1);
        let view = inner.view(now);
        self.persist_inner(&inner)?;
        Ok(view)
    }

    pub fn set_phase(
        &self,
        phase: GamePhase,
        updated_by: Option<String>,
    ) -> Result<GameStateView, GameError> {
        let mut inner = self.write_inner()?;
        let now = Utc::now();
        let view = Self::apply_phase_change(&mut inner, phase, now, updated_by)?;
        self.persist_inner(&inner)?;
        Ok(view)
    }

    pub fn auto_advance_phase(
        &self,
        expected_phase: GamePhase,
        expected_round_id: Option<RoundId>,
        expected_deadline: DateTime<Utc>,
    ) -> Result<Option<GameStateView>, GameError> {
        let mut inner = self.write_inner()?;
        let now = Utc::now();
        if inner.phase != expected_phase
            || inner.current_round_id != expected_round_id
            || inner.phase_ends_at != Some(expected_deadline)
            || now < expected_deadline
        {
            return Ok(None);
        }
        let Some(next_phase) = next_auto_phase(expected_phase) else {
            return Ok(None);
        };
        Self::apply_phase_change(
            &mut inner,
            next_phase,
            now,
            Some("system:auto-advance".to_owned()),
        )
        .and_then(|view| {
            self.persist_inner(&inner)?;
            Ok(Some(view))
        })
    }

    pub fn is_round_submission(&self, submission_id: SubmissionId) -> Result<bool, GameError> {
        Ok(self
            .read_inner()?
            .round_submissions
            .contains_key(&submission_id))
    }

    pub fn attach_submission(&self, submission: &Submission) -> Result<GameStateView, GameError> {
        let mut inner = self.write_inner()?;
        let now = Utc::now();
        if inner.phase != GamePhase::SubmissionOpen {
            return Err(GameError::InvalidPhase);
        }
        if inner.phase_ends_at.is_some_and(|deadline| now > deadline) {
            return Err(GameError::DeadlinePassed);
        }
        let round_id = inner.current_round_id.ok_or(GameError::NoActiveRound)?;
        if inner.current_challenge_id != Some(submission.challenge_id) {
            return Err(GameError::SubmissionNotInRound);
        }
        inner.round_submissions.insert(submission.id, round_id);
        inner.version = inner.version.saturating_add(1);
        inner.updated_at = now;
        let view = inner.view(now);
        self.persist_inner(&inner)?;
        Ok(view)
    }

    pub fn record_team_selection_vote(
        &self,
        repository: &dyn Repository,
        team_id: TeamId,
        device_id: String,
        submission_id: SubmissionId,
    ) -> Result<(TeamSelectionVote, GameStateView), GameError> {
        let submission = repository
            .get_submission(submission_id)
            .map_err(|_| GameError::SubmissionNotFound)?
            .ok_or(GameError::SubmissionNotFound)?;
        if submission.team_id != team_id {
            return Err(GameError::SubmissionTeamMismatch);
        }
        let mut inner = self.write_inner()?;
        let now = Utc::now();
        if inner.phase != GamePhase::TeamSelection {
            return Err(GameError::InvalidPhase);
        }
        if inner.phase_ends_at.is_some_and(|deadline| now > deadline) {
            return Err(GameError::DeadlinePassed);
        }
        let round_id = inner.current_round_id.ok_or(GameError::NoActiveRound)?;
        if inner.round_submissions.get(&submission_id) != Some(&round_id) {
            return Err(GameError::SubmissionNotInRound);
        }
        let key = (round_id, team_id, device_id.clone());
        let created_at = inner
            .team_selection_votes
            .get(&key)
            .map_or(now, |vote| vote.created_at);
        let vote = TeamSelectionVote {
            round_id,
            team_id,
            device_id,
            submission_id,
            created_at,
            updated_at: now,
        };
        inner.team_selection_votes.insert(key, vote.clone());
        inner.lock_nominations(round_id, now);
        inner.version = inner.version.saturating_add(1);
        inner.updated_at = now;
        let view = inner.view(now);
        self.persist_inner(&inner)?;
        Ok((vote, view))
    }

    pub fn record_public_vote(
        &self,
        team_id: TeamId,
        choices: Vec<PublicVoteChoice>,
    ) -> Result<(PublicVote, GameStateView), GameError> {
        let mut inner = self.write_inner()?;
        let now = Utc::now();
        if inner.phase != GamePhase::PublicVoting {
            return Err(GameError::InvalidPhase);
        }
        if inner.phase_ends_at.is_some_and(|deadline| now > deadline) {
            return Err(GameError::DeadlinePassed);
        }
        let round_id = inner.current_round_id.ok_or(GameError::NoActiveRound)?;
        let max_votes = usize::from(inner.public_votes_per_team);
        if choices.is_empty() || choices.len() > max_votes {
            return Err(GameError::InvalidPublicVote);
        }
        let mut seen_teams = HashSet::new();
        let mut seen_submissions = HashSet::new();
        for choice in &choices {
            if choice.target_team_id == team_id
                || !seen_teams.insert(choice.target_team_id)
                || !seen_submissions.insert(choice.target_submission_id)
            {
                return Err(GameError::InvalidPublicVote);
            }
            let nomination = inner
                .nominations
                .get(&(round_id, choice.target_team_id))
                .ok_or(GameError::NominationNotFound)?;
            if nomination.submission_id != choice.target_submission_id {
                return Err(GameError::InvalidPublicVote);
            }
        }
        let created_at = inner
            .public_votes
            .get(&(round_id, team_id))
            .map_or(now, |vote| vote.created_at);
        let vote = PublicVote {
            round_id,
            voter_team_id: team_id,
            choices,
            created_at,
            updated_at: now,
        };
        inner.public_votes.insert((round_id, team_id), vote.clone());
        inner.version = inner.version.saturating_add(1);
        inner.updated_at = now;
        let view = inner.view(now);
        self.persist_inner(&inner)?;
        Ok((vote, view))
    }

    pub fn score_current_round(
        &self,
        repository: &dyn Repository,
        created_by: Option<String>,
    ) -> Result<(Vec<RoundResultEntry>, GameStateView), GameError> {
        let mut inner = self.write_inner()?;
        let now = Utc::now();
        let round_id = inner.current_round_id.ok_or(GameError::NoActiveRound)?;
        inner.lock_nominations(round_id, now);
        let mut counts: HashMap<TeamId, usize> = HashMap::new();
        for vote in inner
            .public_votes
            .values()
            .filter(|vote| vote.round_id == round_id)
        {
            for choice in &vote.choices {
                *counts.entry(choice.target_team_id).or_default() += 1;
            }
        }
        let mut nominations = inner.nominations_for_round(round_id);
        nominations.sort_by(|left, right| {
            counts
                .get(&right.team_id)
                .unwrap_or(&0)
                .cmp(counts.get(&left.team_id).unwrap_or(&0))
                .then(left.selected_at.cmp(&right.selected_at))
        });
        let mut results = Vec::new();
        let mut inputs = Vec::new();
        let result_count = nominations.len();
        for (index, nomination) in nominations.into_iter().enumerate() {
            let vote_count = *counts.get(&nomination.team_id).unwrap_or(&0);
            let placement_points = placement_points_for_rank(index + 1, result_count);
            let in_top_three = index < 3;
            let streak = if in_top_three {
                inner
                    .top_three_streaks
                    .get(&nomination.team_id)
                    .copied()
                    .unwrap_or(0)
                    .saturating_add(1)
            } else {
                0
            };
            inner.top_three_streaks.insert(nomination.team_id, streak);
            let streak_bonus = if in_top_three {
                streak_bonus_for_placement(placement_points, streak)
            } else {
                0
            };
            if placement_points > 0 {
                inputs.push(ScoreEventInput {
                    team_id: nomination.team_id,
                    event_type: ScoreEventType::RoundPlacement,
                    delta: placement_points,
                    score_after: None,
                    refs: ScoreEventRefs {
                        challenge_id: inner.current_challenge_id,
                        submission_id: Some(nomination.submission_id),
                    },
                    reason: Some(format!("round placement #{}", index + 1)),
                    created_by: created_by.clone(),
                });
            }
            if streak_bonus > 0 {
                inputs.push(ScoreEventInput {
                    team_id: nomination.team_id,
                    event_type: ScoreEventType::RoundStreakBonus,
                    delta: streak_bonus,
                    score_after: None,
                    refs: ScoreEventRefs {
                        challenge_id: inner.current_challenge_id,
                        submission_id: Some(nomination.submission_id),
                    },
                    reason: Some(format!("top-three streak x{streak}")),
                    created_by: created_by.clone(),
                });
            }
            results.push(RoundResultEntry {
                rank: index + 1,
                team_id: nomination.team_id,
                submission_id: nomination.submission_id,
                vote_count,
                placement_points,
                streak,
                streak_bonus,
            });
        }
        repository
            .append_score_events_bulk(inputs)
            .map_err(|_| GameError::InvalidPublicVote)?;
        inner.results.insert(round_id, results.clone());
        inner.phase = GamePhase::RoundComplete;
        inner.phase_started_at = now;
        inner.phase_ends_at = None;
        if let Some(round) = inner.rounds.get_mut(&round_id) {
            round.completed_at = Some(now);
        }
        inner.version = inner.version.saturating_add(1);
        inner.updated_at = now;
        inner.updated_by = created_by;
        let view = inner.view(now);
        self.persist_inner(&inner)?;
        Ok((results, view))
    }

    fn read_inner(&self) -> Result<std::sync::RwLockReadGuard<'_, GameInner>, GameError> {
        self.inner.read().map_err(|_| GameError::LockUnavailable)
    }
    fn write_inner(&self) -> Result<std::sync::RwLockWriteGuard<'_, GameInner>, GameError> {
        self.inner.write().map_err(|_| GameError::LockUnavailable)
    }

    fn persist_inner(&self, inner: &GameInner) -> Result<(), GameError> {
        let Some(path) = self.persistence_path.as_ref() else {
            return Ok(());
        };
        atomic_write_json(path, &PersistedGameInner::from(inner)).map_err(|_| {
            tracing::warn!(path = %path.display(), "failed to persist game snapshot");
            GameError::LockUnavailable
        })
    }

    fn apply_phase_change(
        inner: &mut GameInner,
        phase: GamePhase,
        now: DateTime<Utc>,
        updated_by: Option<String>,
    ) -> Result<GameStateView, GameError> {
        let round_id = inner.current_round_id.ok_or(GameError::NoActiveRound)?;
        if phase == GamePhase::TeamSelection {
            inner.lock_nominations(round_id, now);
        }
        if phase == GamePhase::PublicVoting {
            inner.lock_nominations(round_id, now);
        }
        let ends_at = match phase {
            GamePhase::TeamSelection => Some(now + Duration::seconds(inner.team_selection_seconds)),
            GamePhase::SubmissionOpen => inner.rounds.get(&round_id).map(|round| {
                if round.submission_ends_at > now {
                    return round.submission_ends_at;
                }
                let submission_duration =
                    (round.submission_ends_at - round.started_at).max(Duration::seconds(1));
                now + submission_duration
            }),
            GamePhase::PublicVoting => Some(now + Duration::seconds(60)),
            GamePhase::Scoring | GamePhase::RoundComplete | GamePhase::Idle => None,
        };
        if let Some(round) = inner.rounds.get_mut(&round_id) {
            if phase == GamePhase::SubmissionOpen
                && let Some(ends_at) = ends_at
            {
                round.submission_ends_at = ends_at;
            }
            if phase == GamePhase::TeamSelection {
                round.team_selection_ends_at = ends_at;
            }
            if phase == GamePhase::PublicVoting {
                round.public_voting_ends_at = ends_at;
            }
            if phase == GamePhase::RoundComplete {
                round.completed_at = Some(now);
            }
        }
        inner.phase = phase;
        inner.phase_started_at = now;
        inner.phase_ends_at = ends_at;
        inner.updated_at = now;
        inner.updated_by = updated_by;
        inner.version = inner.version.saturating_add(1);
        Ok(inner.view(now))
    }
}

#[derive(Debug, Serialize, Deserialize)]
struct PersistedGameInner {
    version: i64,
    phase: GamePhase,
    current_round_id: Option<RoundId>,
    current_challenge_id: Option<ChallengeId>,
    phase_started_at: DateTime<Utc>,
    phase_ends_at: Option<DateTime<Utc>>,
    public_votes_per_team: u8,
    team_selection_seconds: i64,
    updated_at: DateTime<Utc>,
    updated_by: Option<String>,
    rounds: Vec<Round>,
    round_submissions: Vec<(SubmissionId, RoundId)>,
    team_selection_votes: Vec<TeamSelectionVote>,
    nominations: Vec<TeamNomination>,
    public_votes: Vec<PublicVote>,
    results: Vec<(RoundId, Vec<RoundResultEntry>)>,
    top_three_streaks: Vec<(TeamId, u32)>,
}

impl From<&GameInner> for PersistedGameInner {
    fn from(inner: &GameInner) -> Self {
        Self {
            version: inner.version,
            phase: inner.phase,
            current_round_id: inner.current_round_id,
            current_challenge_id: inner.current_challenge_id,
            phase_started_at: inner.phase_started_at,
            phase_ends_at: inner.phase_ends_at,
            public_votes_per_team: inner.public_votes_per_team,
            team_selection_seconds: inner.team_selection_seconds,
            updated_at: inner.updated_at,
            updated_by: inner.updated_by.clone(),
            rounds: inner.rounds.values().cloned().collect(),
            round_submissions: inner
                .round_submissions
                .iter()
                .map(|(submission_id, round_id)| (*submission_id, *round_id))
                .collect(),
            team_selection_votes: inner.team_selection_votes.values().cloned().collect(),
            nominations: inner.nominations.values().cloned().collect(),
            public_votes: inner.public_votes.values().cloned().collect(),
            results: inner
                .results
                .iter()
                .map(|(round_id, results)| (*round_id, results.clone()))
                .collect(),
            top_three_streaks: inner
                .top_three_streaks
                .iter()
                .map(|(team_id, streak)| (*team_id, *streak))
                .collect(),
        }
    }
}

impl From<PersistedGameInner> for GameInner {
    fn from(persisted: PersistedGameInner) -> Self {
        Self {
            version: persisted.version,
            phase: persisted.phase,
            current_round_id: persisted.current_round_id,
            current_challenge_id: persisted.current_challenge_id,
            phase_started_at: persisted.phase_started_at,
            phase_ends_at: persisted.phase_ends_at,
            public_votes_per_team: persisted.public_votes_per_team,
            team_selection_seconds: persisted.team_selection_seconds,
            updated_at: persisted.updated_at,
            updated_by: persisted.updated_by,
            rounds: persisted
                .rounds
                .into_iter()
                .map(|round| (round.id, round))
                .collect(),
            round_submissions: persisted.round_submissions.into_iter().collect(),
            team_selection_votes: persisted
                .team_selection_votes
                .into_iter()
                .map(|vote| ((vote.round_id, vote.team_id, vote.device_id.clone()), vote))
                .collect(),
            nominations: persisted
                .nominations
                .into_iter()
                .map(|nomination| ((nomination.round_id, nomination.team_id), nomination))
                .collect(),
            public_votes: persisted
                .public_votes
                .into_iter()
                .map(|vote| ((vote.round_id, vote.voter_team_id), vote))
                .collect(),
            results: persisted.results.into_iter().collect(),
            top_three_streaks: persisted.top_three_streaks.into_iter().collect(),
        }
    }
}

fn next_auto_phase(phase: GamePhase) -> Option<GamePhase> {
    match phase {
        GamePhase::SubmissionOpen => Some(GamePhase::TeamSelection),
        GamePhase::TeamSelection => Some(GamePhase::PublicVoting),
        GamePhase::PublicVoting => Some(GamePhase::RoundComplete),
        GamePhase::Idle | GamePhase::Scoring | GamePhase::RoundComplete => None,
    }
}

#[derive(Debug)]
struct GameInner {
    version: i64,
    phase: GamePhase,
    current_round_id: Option<RoundId>,
    current_challenge_id: Option<ChallengeId>,
    phase_started_at: DateTime<Utc>,
    phase_ends_at: Option<DateTime<Utc>>,
    public_votes_per_team: u8,
    team_selection_seconds: i64,
    updated_at: DateTime<Utc>,
    updated_by: Option<String>,
    rounds: HashMap<RoundId, Round>,
    round_submissions: HashMap<SubmissionId, RoundId>,
    team_selection_votes: HashMap<(RoundId, TeamId, String), TeamSelectionVote>,
    nominations: HashMap<(RoundId, TeamId), TeamNomination>,
    public_votes: HashMap<(RoundId, TeamId), PublicVote>,
    results: HashMap<RoundId, Vec<RoundResultEntry>>,
    top_three_streaks: HashMap<TeamId, u32>,
}

impl Default for GameInner {
    fn default() -> Self {
        let now = Utc::now();
        Self {
            version: 0,
            phase: GamePhase::Idle,
            current_round_id: None,
            current_challenge_id: None,
            phase_started_at: now,
            phase_ends_at: None,
            public_votes_per_team: 3,
            team_selection_seconds: 60,
            updated_at: now,
            updated_by: None,
            rounds: HashMap::new(),
            round_submissions: HashMap::new(),
            team_selection_votes: HashMap::new(),
            nominations: HashMap::new(),
            public_votes: HashMap::new(),
            results: HashMap::new(),
            top_three_streaks: HashMap::new(),
        }
    }
}

impl GameInner {
    fn view(&self, server_now: DateTime<Utc>) -> GameStateView {
        GameStateView {
            version: self.version,
            phase: self.phase,
            current_round_id: self.current_round_id,
            current_challenge_id: self.current_challenge_id,
            phase_started_at: self.phase_started_at,
            phase_ends_at: self.phase_ends_at,
            public_votes_per_team: self.public_votes_per_team,
            team_selection_seconds: self.team_selection_seconds,
            updated_at: self.updated_at,
            updated_by: self.updated_by.clone(),
            server_now,
        }
    }

    fn current_round(&self) -> Option<Round> {
        self.current_round_id
            .and_then(|round_id| self.rounds.get(&round_id).cloned())
    }

    fn nominations_for_round(&self, round_id: RoundId) -> Vec<TeamNomination> {
        let mut nominations: Vec<_> = self
            .nominations
            .values()
            .filter(|nomination| nomination.round_id == round_id)
            .cloned()
            .collect();
        nominations.sort_by(|left, right| left.team_id.cmp(&right.team_id));
        nominations
    }

    fn submissions_for_round(
        &self,
        repository: &dyn Repository,
        round_id: RoundId,
    ) -> Vec<Submission> {
        let mut submissions: Vec<_> = self
            .round_submissions
            .iter()
            .filter(|(_, stored_round_id)| **stored_round_id == round_id)
            .filter_map(|(submission_id, _)| {
                repository.get_submission(*submission_id).ok().flatten()
            })
            .collect();
        submissions.sort_by(|left, right| {
            left.created_at
                .cmp(&right.created_at)
                .then(left.team_id.cmp(&right.team_id))
                .then(left.id.cmp(&right.id))
        });
        submissions
    }

    fn public_vote_counts_for_round(&self, round_id: RoundId) -> Vec<PublicVoteCount> {
        let mut counts: HashMap<(TeamId, SubmissionId), usize> = HashMap::new();
        for vote in self
            .public_votes
            .values()
            .filter(|vote| vote.round_id == round_id)
        {
            for choice in &vote.choices {
                *counts
                    .entry((choice.target_team_id, choice.target_submission_id))
                    .or_default() += 1;
            }
        }
        let mut counts: Vec<_> = counts
            .into_iter()
            .map(
                |((target_team_id, target_submission_id), vote_count)| PublicVoteCount {
                    target_team_id,
                    target_submission_id,
                    vote_count,
                },
            )
            .collect();
        counts.sort_by(|left, right| {
            right
                .vote_count
                .cmp(&left.vote_count)
                .then(left.target_team_id.cmp(&right.target_team_id))
        });
        counts
    }

    fn lock_nominations(&mut self, round_id: RoundId, now: DateTime<Utc>) {
        let mut by_team: HashMap<TeamId, HashMap<SubmissionId, usize>> = HashMap::new();
        for vote in self
            .team_selection_votes
            .values()
            .filter(|vote| vote.round_id == round_id)
        {
            *by_team
                .entry(vote.team_id)
                .or_default()
                .entry(vote.submission_id)
                .or_default() += 1;
        }
        for (&submission_id, &stored_round_id) in &self.round_submissions {
            if stored_round_id == round_id {
                // Submissions with no votes are not nominated until a vote exists; explicit voting is required.
                let _ = submission_id;
            }
        }
        for (team_id, counts) in by_team {
            let Some((submission_id, vote_count)) = counts
                .into_iter()
                .max_by(|left, right| left.1.cmp(&right.1).then(right.0.cmp(&left.0)))
            else {
                continue;
            };
            self.nominations.insert(
                (round_id, team_id),
                TeamNomination {
                    round_id,
                    team_id,
                    submission_id,
                    vote_count,
                    selected_at: now,
                },
            );
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ServiceReadiness {
    Ok,
    Unavailable(String),
}

fn read_json<T>(path: &Path) -> Option<T>
where
    T: for<'de> Deserialize<'de>,
{
    if !path.exists() {
        return None;
    }
    match fs::read(path).and_then(|bytes| {
        serde_json::from_slice(&bytes)
            .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error))
    }) {
        Ok(value) => Some(value),
        Err(error) => {
            tracing::warn!(path = %path.display(), %error, "failed to load persistence snapshot");
            None
        }
    }
}

fn atomic_write_json<T>(path: &Path, value: &T) -> std::io::Result<()>
where
    T: Serialize,
{
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let tmp_path = path.with_extension("tmp");
    let bytes = serde_json::to_vec_pretty(value).map_err(std::io::Error::other)?;
    fs::write(&tmp_path, bytes)?;
    fs::rename(tmp_path, path)?;
    Ok(())
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
    #[error("stream session id is invalid")]
    InvalidatedStreamSession,
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
}

#[derive(Debug, Clone, PartialEq)]
pub struct ChallengeStats {
    pub submission_count: usize,
    pub solved_count: usize,
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
    pub result_image_asset_id: Option<String>,
    pub result_image_path: Option<String>,
    pub result_image_url: Option<String>,
}

#[derive(Debug, Default, Clone)]
pub struct InMemoryDatabase {
    inner: Arc<RwLock<StoreInner>>,
    persistence_path: Option<Arc<PathBuf>>,
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

    fn mark_submission_running(
        &self,
        submission_id: SubmissionId,
    ) -> Result<Submission, StoreError> {
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

    fn get_submission(
        &self,
        submission_id: SubmissionId,
    ) -> Result<Option<Submission>, StoreError> {
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
    pub fn from_file(path: PathBuf) -> Self {
        let inner = read_json::<PersistedStoreInner>(&path)
            .map(StoreInner::from)
            .unwrap_or_default();
        Self {
            inner: Arc::new(RwLock::new(inner)),
            persistence_path: Some(Arc::new(path)),
        }
    }

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
        self.persist_inner(&inner)?;
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
        let team = team.clone();
        self.persist_inner(&inner)?;
        Ok(team)
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

        self.persist_inner(&inner)?;
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
        self.persist_inner(&inner)?;
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
        let challenge_set = challenge_set.clone();
        self.persist_inner(&inner)?;
        Ok(challenge_set)
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
        let challenge_set = challenge_set.clone();
        self.persist_inner(&inner)?;
        Ok(challenge_set)
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
            enabled: input.enabled,
            order: input.order,
            canvas: input.canvas,
            judge_config: input.judge_config,
            created_at: now,
            updated_at: now,
        };
        inner.challenge_slugs.insert(slug_key, challenge.id);
        inner.challenges.insert(challenge.id, challenge.clone());
        self.persist_inner(&inner)?;
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
        if let Some(enabled) = update.enabled {
            challenge.enabled = enabled;
        }
        if let Some(order) = update.order {
            challenge.order = order;
        }
        challenge.updated_at = Utc::now();
        let challenge = challenge.clone();
        self.persist_inner(&inner)?;
        Ok(challenge)
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
        let challenge = challenge.clone();
        self.persist_inner(&inner)?;
        Ok(challenge)
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
        self.persist_inner(&inner)?;
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
        for _submission in inner.submissions.values().filter(|submission| {
            submission.team_id == team_id && submission.challenge_id == challenge_id
        }) {
            submission_count = submission_count.saturating_add(1);
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
        self.persist_inner(&inner)?;
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
        let submission = submission.clone();
        self.persist_inner(&inner)?;
        Ok(submission)
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
        let submission = submission.clone();
        self.persist_inner(&inner)?;
        Ok(submission)
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
        let submission = submission.clone();
        self.persist_inner(&inner)?;
        Ok(Some(submission))
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
        let submission = submission.clone();
        self.persist_inner(&inner)?;
        Ok(submission)
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
        submission.result_image_asset_id = result.result_image_asset_id;
        submission.result_image_path = result.result_image_path;
        submission.result_image_url = result.result_image_url;
        submission.updated_at = now;
        submission.completed_at = Some(now);
        let submission = submission.clone();
        self.persist_inner(&inner)?;
        Ok(submission)
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
        let submission = submission.clone();
        self.persist_inner(&inner)?;
        Ok(submission)
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
        self.persist_inner(&inner)?;
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
        self.persist_inner(&inner)?;
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

        let teams = update_team_scores(&mut inner, scores)?;
        self.persist_inner(&inner)?;
        Ok(teams)
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

        let teams = update_team_scores(&mut inner, scores)?;
        self.persist_inner(&inner)?;
        Ok(teams)
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

    fn persist_inner(&self, inner: &StoreInner) -> Result<(), StoreError> {
        let Some(path) = self.persistence_path.as_ref() else {
            return Ok(());
        };
        atomic_write_json(path, &PersistedStoreInner::from(inner)).map_err(|error| {
            tracing::warn!(path = %path.display(), %error, "failed to persist database snapshot");
            StoreError::LockUnavailable
        })
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

#[derive(Debug, Serialize, Deserialize)]
struct PersistedStoreInner {
    teams: Vec<Team>,
    challenge_sets: Vec<ChallengeSet>,
    challenges: Vec<Challenge>,
    submissions: Vec<Submission>,
    score_events: Vec<ScoreEvent>,
    last_submission_at: Vec<(TeamId, DateTime<Utc>)>,
    next_queue_order: i64,
}

impl From<&StoreInner> for PersistedStoreInner {
    fn from(inner: &StoreInner) -> Self {
        Self {
            teams: inner.teams.values().cloned().collect(),
            challenge_sets: inner.challenge_sets.values().cloned().collect(),
            challenges: inner.challenges.values().cloned().collect(),
            submissions: inner.submissions.values().cloned().collect(),
            score_events: inner.score_events.clone(),
            last_submission_at: inner
                .last_submission_at
                .iter()
                .map(|(team_id, submitted_at)| (*team_id, *submitted_at))
                .collect(),
            next_queue_order: inner.next_queue_order,
        }
    }
}

impl From<PersistedStoreInner> for StoreInner {
    fn from(persisted: PersistedStoreInner) -> Self {
        let teams: HashMap<_, _> = persisted
            .teams
            .into_iter()
            .map(|team| (team.id, team))
            .collect();
        let login_codes = teams
            .values()
            .map(|team| (team.login_code.clone(), team.id))
            .collect();
        let challenge_sets = persisted
            .challenge_sets
            .into_iter()
            .map(|challenge_set| (challenge_set.id, challenge_set))
            .collect();
        let challenges: HashMap<_, _> = persisted
            .challenges
            .into_iter()
            .map(|challenge| (challenge.id, challenge))
            .collect();
        let challenge_slugs = challenges
            .values()
            .map(|challenge| {
                (
                    (challenge.challenge_set_id, challenge.slug.clone()),
                    challenge.id,
                )
            })
            .collect();
        let submissions: HashMap<_, _> = persisted
            .submissions
            .into_iter()
            .map(|submission| (submission.id, submission))
            .collect();
        let minimum_next_queue_order = submissions
            .values()
            .map(|submission| submission.queue_order)
            .max()
            .and_then(|queue_order| queue_order.checked_add(1))
            .unwrap_or(0);

        Self {
            teams,
            login_codes,
            challenge_sets,
            challenges,
            challenge_slugs,
            submissions,
            score_events: persisted.score_events,
            last_submission_at: persisted.last_submission_at.into_iter().collect(),
            next_queue_order: persisted.next_queue_order.max(minimum_next_queue_order),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StoredAssetMetadata {
    pub id: String,
    pub content_type: String,
    pub byte_len: usize,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoredAsset {
    pub metadata: StoredAssetMetadata,
    pub bytes: Vec<u8>,
}

#[derive(Debug, Default, Clone)]
pub struct InMemoryStorage {
    assets: Arc<RwLock<HashMap<String, StoredAsset>>>,
    persistence_path: Option<Arc<PathBuf>>,
}

impl InMemoryStorage {
    pub fn from_file(path: PathBuf) -> Self {
        let assets = read_json::<PersistedStorage>(&path)
            .map(|persisted| {
                persisted
                    .assets
                    .into_iter()
                    .map(|asset| (asset.metadata.id.clone(), asset))
                    .collect()
            })
            .unwrap_or_default();
        Self {
            assets: Arc::new(RwLock::new(assets)),
            persistence_path: Some(Arc::new(path)),
        }
    }

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
        self.persist_assets(&assets)?;
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

#[derive(Debug, Serialize, Deserialize)]
struct PersistedStorage {
    assets: Vec<StoredAsset>,
}

impl InMemoryStorage {
    fn persist_assets(&self, assets: &HashMap<String, StoredAsset>) -> Result<(), StoreError> {
        let Some(path) = self.persistence_path.as_ref() else {
            return Ok(());
        };
        let persisted = PersistedStorage {
            assets: assets.values().cloned().collect(),
        };
        atomic_write_json(path, &persisted).map_err(|error| {
            tracing::warn!(path = %path.display(), %error, "failed to persist asset snapshot");
            StoreError::LockUnavailable
        })
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

const PLACEMENT_MAX_POINTS: i32 = 1_000;
const PLACEMENT_MIN_POINTS: i32 = 300;
const PLACEMENT_DECAY: f64 = 1.35;
const STREAK_BONUS_STEP: f64 = 0.03;
const STREAK_BONUS_CAP: f64 = 0.15;

fn placement_points_for_rank(rank: usize, total: usize) -> i32 {
    if total == 0 || rank == 0 {
        return 0;
    }

    if total == 1 {
        return PLACEMENT_MAX_POINTS;
    }

    let rank_index = rank.saturating_sub(1) as f64;
    let last_index = total.saturating_sub(1) as f64;
    let normalized = 1.0 - (rank_index / last_index);
    let points = f64::from(PLACEMENT_MIN_POINTS)
        + f64::from(PLACEMENT_MAX_POINTS - PLACEMENT_MIN_POINTS) * normalized.powf(PLACEMENT_DECAY);

    points.round() as i32
}

fn streak_bonus_for_placement(placement_points: i32, streak: u32) -> i32 {
    if placement_points <= 0 || streak <= 1 {
        return 0;
    }

    let bonus_rate =
        (f64::from(streak.saturating_sub(1)) * STREAK_BONUS_STEP).min(STREAK_BONUS_CAP);
    (f64::from(placement_points) * bonus_rate).round() as i32
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn expired_stream_session_is_removed_and_invalidated() {
        let store = BlackboardStore::default();
        let team_id = TeamId::from(uuid::Uuid::new_v4());

        store
            .register_stream_session(
                "session-a".to_owned(),
                team_id,
                "device-a".to_owned(),
                "connection-a".to_owned(),
            )
            .expect("stream session should register");

        assert!(
            !store
                .expire_disconnected_stream_session("session-a", "connection-a")
                .expect("connected session should not expire")
        );

        assert!(
            store
                .disconnect_stream_session("session-a", "connection-a")
                .expect("session should disconnect")
        );
        assert!(
            store
                .expire_disconnected_stream_session("session-a", "connection-a")
                .expect("offline session should expire")
        );
        assert!(
            store
                .stream_sessions()
                .expect("sessions should read")
                .is_empty()
        );
        assert!(matches!(
            store.register_stream_session(
                "session-a".to_owned(),
                team_id,
                "device-a".to_owned(),
                "connection-b".to_owned(),
            ),
            Err(StoreError::InvalidatedStreamSession)
        ));
    }

    #[test]
    fn stale_stream_connection_cannot_disconnect_replacement() {
        let store = BlackboardStore::default();
        let team_id = TeamId::from(uuid::Uuid::new_v4());

        store
            .register_stream_session(
                "session-a".to_owned(),
                team_id,
                "device-a".to_owned(),
                "connection-a".to_owned(),
            )
            .expect("first stream session should register");
        store
            .register_stream_session(
                "session-a".to_owned(),
                team_id,
                "device-a".to_owned(),
                "connection-b".to_owned(),
            )
            .expect("replacement stream session should register");

        assert!(
            !store
                .disconnect_stream_session("session-a", "connection-a")
                .expect("stale connection should be ignored")
        );
        assert!(
            !store
                .expire_disconnected_stream_session("session-a", "connection-a")
                .expect("stale connection should not expire replacement")
        );

        let session = store
            .stream_session("session-a")
            .expect("active session should read")
            .expect("active session should exist");
        assert!(session.connected);
        assert_eq!(session.device_id, "device-a");
    }

    #[tokio::test]
    async fn blackboard_signaling_routes_viewer_lifecycle_messages() {
        let hub = BlackboardSignalHub::default();
        let (team_tx, mut team_rx) = mpsc::unbounded_channel();
        let (viewer_tx, mut viewer_rx) = mpsc::unbounded_channel();

        hub.register_team("session-a".to_owned(), "connection-a".to_owned(), team_tx)
            .await;

        assert!(
            hub.register_viewer(
                "session-a".to_owned(),
                "viewer-a".to_owned(),
                BlackboardViewerKind::Public,
                60,
                viewer_tx,
            )
            .await
        );
        assert_eq!(
            recv_signal(&mut team_rx).await,
            r#"{"type":"webrtc_viewer_joined","viewer_id":"viewer-a","viewer_kind":"public","target_fps":60}"#
        );

        assert!(hub.send_to_viewer("viewer-a", "offer".to_owned()).await);
        assert_eq!(recv_signal(&mut viewer_rx).await, "offer");

        assert!(hub.send_to_team("session-a", "answer".to_owned()).await);
        assert_eq!(recv_signal(&mut team_rx).await, "answer");

        hub.unregister_viewer("viewer-a").await;
        assert_eq!(
            recv_signal(&mut team_rx).await,
            r#"{"type":"webrtc_viewer_left","viewer_id":"viewer-a","viewer_kind":"public"}"#
        );
    }

    #[tokio::test]
    async fn blackboard_signaling_closes_only_unselected_public_viewers() {
        let hub = BlackboardSignalHub::default();
        let (team_a_tx, mut team_a_rx) = mpsc::unbounded_channel();
        let (team_b_tx, mut team_b_rx) = mpsc::unbounded_channel();
        let (viewer_a_tx, mut viewer_a_rx) = mpsc::unbounded_channel();
        let (viewer_b_tx, mut viewer_b_rx) = mpsc::unbounded_channel();
        let (admin_viewer_tx, mut admin_viewer_rx) = mpsc::unbounded_channel();

        hub.register_team("session-a".to_owned(), "connection-a".to_owned(), team_a_tx)
            .await;
        hub.register_team("session-b".to_owned(), "connection-b".to_owned(), team_b_tx)
            .await;
        assert!(
            hub.register_viewer(
                "session-a".to_owned(),
                "viewer-a".to_owned(),
                BlackboardViewerKind::Public,
                60,
                viewer_a_tx,
            )
            .await
        );
        assert!(
            hub.register_viewer(
                "session-b".to_owned(),
                "viewer-b".to_owned(),
                BlackboardViewerKind::Public,
                60,
                viewer_b_tx,
            )
            .await
        );
        assert!(
            hub.register_viewer(
                "session-b".to_owned(),
                "admin-viewer".to_owned(),
                BlackboardViewerKind::AdminPreview,
                2,
                admin_viewer_tx,
            )
            .await
        );
        let _ = recv_signal(&mut team_a_rx).await;
        let _ = recv_signal(&mut team_b_rx).await;
        let _ = recv_signal(&mut team_b_rx).await;

        hub.close_public_viewers_except(Some("session-a")).await;

        assert_eq!(
            recv_signal(&mut viewer_b_rx).await,
            r#"{"type":"webrtc_stream_closed"}"#
        );
        assert_eq!(
            recv_signal(&mut team_b_rx).await,
            r#"{"type":"webrtc_viewer_left","viewer_id":"viewer-b","viewer_kind":"public"}"#
        );
        assert!(viewer_a_rx.try_recv().is_err());
        assert!(admin_viewer_rx.try_recv().is_err());
        assert!(
            hub.send_to_viewer("viewer-a", "still-open".to_owned())
                .await
        );
        assert_eq!(recv_signal(&mut viewer_a_rx).await, "still-open");
        assert!(
            hub.send_to_viewer("admin-viewer", "preview-open".to_owned())
                .await
        );
        assert_eq!(recv_signal(&mut admin_viewer_rx).await, "preview-open");
    }

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
    fn game_store_starts_round_records_votes_and_scores() {
        let store = InMemoryDatabase::default();
        let game = GameStore::default();
        let (team, challenge) = team_and_challenge(&store);
        let second_team = store
            .create_team("second", "second", None)
            .expect("second team should create");

        let view = game
            .start_round(
                &store,
                StartRoundInput {
                    challenge_id: challenge.id,
                    submission_seconds: 60,
                    public_votes_per_team: 3,
                    created_by: Some("admin".to_owned()),
                },
            )
            .expect("round should start");
        assert_eq!(view.phase, GamePhase::SubmissionOpen);

        let submission = store
            .create_submission(team.id, challenge.id, json!({ "team": 1 }), None)
            .expect("submission should create");
        game.attach_submission(&submission)
            .expect("submission should attach to round");
        let second_submission = store
            .create_submission(second_team.id, challenge.id, json!({ "team": 2 }), None)
            .expect("second submission should create");
        game.attach_submission(&second_submission)
            .expect("second submission should attach");

        game.set_phase(GamePhase::TeamSelection, Some("admin".to_owned()))
            .expect("phase should update");
        game.record_team_selection_vote(&store, team.id, "device-1".to_owned(), submission.id)
            .expect("team vote should record");
        game.record_team_selection_vote(
            &store,
            second_team.id,
            "device-2".to_owned(),
            second_submission.id,
        )
        .expect("second team vote should record");

        game.set_phase(GamePhase::PublicVoting, Some("admin".to_owned()))
            .expect("public voting should start");
        game.record_public_vote(
            second_team.id,
            vec![PublicVoteChoice {
                target_team_id: team.id,
                target_submission_id: submission.id,
                rank: 1,
            }],
        )
        .expect("public vote should record");

        let (results, view) = game
            .score_current_round(&store, Some("admin".to_owned()))
            .expect("round should score");
        assert_eq!(view.phase, GamePhase::RoundComplete);
        assert_eq!(results[0].team_id, team.id);
        assert_eq!(results[0].placement_points, 1_000);
        let scored_team = store
            .get_team(team.id)
            .expect("store should read")
            .expect("team should exist");
        assert_eq!(scored_team.total_score, 1_000);
    }

    #[test]
    fn game_store_rejects_public_vote_for_self_or_non_nomination() {
        let store = InMemoryDatabase::default();
        let game = GameStore::default();
        let (team, challenge) = team_and_challenge(&store);
        game.start_round(
            &store,
            StartRoundInput {
                challenge_id: challenge.id,
                submission_seconds: 60,
                public_votes_per_team: 3,
                created_by: None,
            },
        )
        .expect("round should start");
        let submission = store
            .create_submission(team.id, challenge.id, json!({}), None)
            .expect("submission should create");
        game.attach_submission(&submission)
            .expect("submission should attach");
        game.set_phase(GamePhase::TeamSelection, None)
            .expect("team selection should start");
        game.record_team_selection_vote(&store, team.id, "device".to_owned(), submission.id)
            .expect("team vote should record");
        game.set_phase(GamePhase::PublicVoting, None)
            .expect("public voting should start");

        let error = game
            .record_public_vote(
                team.id,
                vec![PublicVoteChoice {
                    target_team_id: team.id,
                    target_submission_id: submission.id,
                    rank: 1,
                }],
            )
            .expect_err("self vote should fail");
        assert_eq!(error, GameError::InvalidPublicVote);
    }

    #[test]
    fn game_store_auto_advances_only_matching_expired_phase() {
        let store = InMemoryDatabase::default();
        let game = GameStore::default();
        let (_team, challenge) = team_and_challenge(&store);
        let view = game
            .start_round(
                &store,
                StartRoundInput {
                    challenge_id: challenge.id,
                    submission_seconds: 60,
                    public_votes_per_team: 3,
                    created_by: None,
                },
            )
            .expect("round should start");
        let old_deadline = view.phase_ends_at.expect("round has deadline");
        let round_id = view.current_round_id;
        let expired_deadline = Utc::now() - Duration::seconds(1);
        game.update_timer(expired_deadline, None)
            .expect("timer should update");

        let stale = game
            .auto_advance_phase(GamePhase::SubmissionOpen, round_id, old_deadline)
            .expect("stale auto advance should not fail");
        assert!(stale.is_none());

        let advanced = game
            .auto_advance_phase(GamePhase::SubmissionOpen, round_id, expired_deadline)
            .expect("expired phase should advance")
            .expect("phase should advance");
        assert_eq!(advanced.phase, GamePhase::TeamSelection);
        assert_eq!(advanced.updated_by.as_deref(), Some("system:auto-advance"));
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

    #[test]
    fn repository_snapshot_persists_and_reloads_core_state() {
        let path = temp_snapshot_path("store");
        let store = InMemoryDatabase::from_file(path.clone());
        let (team, challenge) = team_and_challenge(&store);
        let submission = store
            .create_submission(team.id, challenge.id, json!({ "blocks": [] }), None)
            .expect("submission should create");
        store
            .mark_submission_completed(
                submission.id,
                CompletedSubmission {
                    trace: Some(json!({ "steps": [] })),
                    result_image_asset_id: Some("result-1".to_owned()),
                    result_image_path: Some("results/result-1.png".to_owned()),
                    result_image_url: None,
                },
            )
            .expect("submission should complete");
        store
            .append_score_event(ScoreEventInput::challenge_pass(
                team.id,
                challenge.id,
                submission.id,
                challenge.points,
            ))
            .expect("score event should append");

        let reloaded = InMemoryDatabase::from_file(path);
        let reloaded_team = reloaded
            .team_by_login_code("code")
            .expect("store should read")
            .expect("team should reload");
        assert_eq!(reloaded_team.id, team.id);
        assert_eq!(reloaded_team.total_score, challenge.points);

        let reloaded_submission = reloaded
            .get_submission(submission.id)
            .expect("store should read")
            .expect("submission should reload");
        assert_eq!(reloaded_submission.status, SubmissionStatus::Completed);
        assert_eq!(
            reloaded_submission.result_image_asset_id.as_deref(),
            Some("result-1")
        );

        let score_events = reloaded
            .list_score_events(ScoreEventListFilter::default())
            .expect("score events should reload");
        assert_eq!(score_events.len(), 1);
        assert_eq!(score_events[0].team_id, team.id);

        let duplicate_slug = reloaded.create_challenge(NewChallenge {
            challenge_set_id: challenge.challenge_set_id,
            slug: challenge.slug.clone(),
            title: "Duplicate".to_owned(),
            description: String::new(),
            target_image_asset_id: None,
            target_image_path: None,
            target_image_url: None,
            points: 1,
            enabled: true,
            order: 2,
            canvas: CanvasConfig::default(),
            judge_config: json!({}),
        });
        assert_eq!(duplicate_slug, Err(StoreError::DuplicateChallengeSlug));

        let next_submission = reloaded
            .create_submission(team.id, challenge.id, json!({ "blocks": ["next"] }), None)
            .expect("next submission should create");
        assert!(next_submission.queue_order > submission.queue_order);
    }

    #[test]
    fn game_snapshot_persists_and_reloads_round_state() {
        let path = temp_snapshot_path("game");
        let store = InMemoryDatabase::default();
        let game = GameStore::from_file(path.clone());
        let (team, challenge) = team_and_challenge(&store);
        let submission = store
            .create_submission(team.id, challenge.id, json!({}), None)
            .expect("submission should create");

        game.start_round(
            &store,
            StartRoundInput {
                challenge_id: challenge.id,
                submission_seconds: 60,
                public_votes_per_team: 3,
                created_by: Some("admin".to_owned()),
            },
        )
        .expect("round should start");
        game.attach_submission(&submission)
            .expect("submission should attach");
        game.set_phase(GamePhase::TeamSelection, Some("admin".to_owned()))
            .expect("phase should update");
        game.record_team_selection_vote(&store, team.id, "device-1".to_owned(), submission.id)
            .expect("team vote should record");

        let reloaded = GameStore::from_file(path);
        let snapshot = reloaded
            .snapshot(&store, Some(team.id))
            .expect("game should reload");
        assert_eq!(snapshot.state.phase, GamePhase::TeamSelection);
        assert_eq!(snapshot.round_submissions.len(), 1);
        assert_eq!(snapshot.round_submissions[0].id, submission.id);
        assert_eq!(snapshot.nominations.len(), 1);
        assert_eq!(snapshot.nominations[0].submission_id, submission.id);
        assert!(snapshot.my_team_selection_vote.is_some());
    }

    #[test]
    fn asset_snapshot_persists_and_reloads_bytes() {
        let path = temp_snapshot_path("assets");
        let storage = InMemoryStorage::from_file(path.clone());
        storage
            .put_asset("asset-1", "image/png", vec![1, 2, 3, 4])
            .expect("asset should persist");

        let reloaded = InMemoryStorage::from_file(path);
        let asset = reloaded
            .get_asset("asset-1")
            .expect("asset store should read")
            .expect("asset should reload");
        assert_eq!(asset.metadata.id, "asset-1");
        assert_eq!(asset.metadata.content_type, "image/png");
        assert_eq!(asset.metadata.byte_len, 4);
        assert_eq!(asset.bytes, vec![1, 2, 3, 4]);
    }

    fn temp_snapshot_path(name: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!("turtle-game-{name}-{}.json", uuid::Uuid::new_v4()))
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
                enabled: true,
                order: 1,
                canvas: CanvasConfig::default(),
                judge_config: json!({ "timeout_ms": 1000 }),
            })
            .expect("challenge should create");
        (team, challenge)
    }

    async fn recv_signal(receiver: &mut mpsc::UnboundedReceiver<String>) -> String {
        tokio::time::timeout(std::time::Duration::from_secs(1), receiver.recv())
            .await
            .expect("signal should arrive")
            .expect("signal channel should remain open")
    }
}
