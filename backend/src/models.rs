use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

pub type Timestamp = DateTime<Utc>;

macro_rules! uuid_id {
    ($name:ident) => {
        #[derive(
            Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize,
        )]
        #[serde(transparent)]
        pub struct $name(pub Uuid);

        impl $name {
            #[must_use]
            pub fn new() -> Self {
                Self(Uuid::new_v4())
            }

            #[must_use]
            pub fn as_uuid(self) -> Uuid {
                self.0
            }
        }

        impl Default for $name {
            fn default() -> Self {
                Self::new()
            }
        }

        impl From<Uuid> for $name {
            fn from(value: Uuid) -> Self {
                Self(value)
            }
        }
    };
}

uuid_id!(TeamId);
uuid_id!(ChallengeSetId);
uuid_id!(ChallengeId);
uuid_id!(SubmissionId);
uuid_id!(ScoreEventId);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Role {
    Team,
    Admin,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ChallengeSetStatus {
    Draft,
    Active,
    Archived,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SubmissionStatus {
    Queued,
    Running,
    Completed,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ScoreEventType {
    ChallengePass,
    AdminAdd,
    AdminSubtract,
    AdminSet,
    AdminAdjust,
    Recalculation,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ChallengeProgressStatus {
    NotStarted,
    Attempted,
    Solved,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Team {
    pub id: TeamId,
    pub name: String,
    pub login_code: String,
    pub enabled: bool,
    pub note: Option<String>,
    pub total_score: i32,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChallengeSet {
    pub id: ChallengeSetId,
    pub name: String,
    pub version: String,
    pub status: ChallengeSetStatus,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Challenge {
    pub id: ChallengeId,
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
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Submission {
    pub id: SubmissionId,
    pub team_id: TeamId,
    pub challenge_id: ChallengeId,
    pub attempt_no: u32,
    pub block_program: Value,
    pub status: SubmissionStatus,
    pub queue_order: i64,
    pub priority: i32,
    pub result_image_asset_id: Option<String>,
    pub result_image_path: Option<String>,
    pub result_image_url: Option<String>,
    pub trace: Option<Value>,
    pub similarity: Option<f64>,
    pub passed: Option<bool>,
    pub judge_score: Option<f64>,
    pub awarded_points: Option<i32>,
    pub error_message: Option<String>,
    pub retry_of: Option<SubmissionId>,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
    pub started_at: Option<Timestamp>,
    pub completed_at: Option<Timestamp>,
    pub cancelled_at: Option<Timestamp>,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct ScoreEventRefs {
    pub challenge_id: Option<ChallengeId>,
    pub submission_id: Option<SubmissionId>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ScoreEvent {
    pub id: ScoreEventId,
    pub team_id: TeamId,
    #[serde(rename = "type")]
    pub event_type: ScoreEventType,
    pub score_before: i32,
    pub score_after: i32,
    pub delta: i32,
    pub refs: ScoreEventRefs,
    pub reason: Option<String>,
    pub created_by: Option<String>,
    pub created_at: Timestamp,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CanvasConfig {
    pub width: u32,
    pub height: u32,
    pub background_color: String,
}

impl Default for CanvasConfig {
    fn default() -> Self {
        Self {
            width: 800,
            height: 600,
            background_color: "#ffffff".to_owned(),
        }
    }
}
