export type Role = "team" | "admin"
export type Timestamp = string

export type ApiErrorBody = {
  error: {
    code: string
    message: string
    details: unknown | null
  }
}

export type Team = {
  id: string
  name: string
  enabled: boolean
  note: string | null
  total_score: number
  created_at: Timestamp
  updated_at: Timestamp
}

export type TeamLoginResponse = {
  team: Team
  access_token: string
  role: Role
  subject: string
}

export type CanvasConfig = {
  width: number
  height: number
  background_color: string
}

export type ChallengeProgressStatus = "not_started" | "attempted" | "solved"

export type Challenge = {
  id: string
  challenge_set_id: string
  slug: string
  title: string
  description: string
  target_image_asset_id: string | null
  target_image_path: string | null
  target_image_url: string | null
  points: number
  pass_threshold: number
  enabled: boolean
  order: number
  canvas: CanvasConfig
  judge_config: unknown
  status: ChallengeProgressStatus
  submission_count: number
  best_similarity: number | null
  best_submission_id: string | null
  awarded_points: number | null
  created_at: Timestamp
  updated_at: Timestamp
}

export type SubmissionStatus = "queued" | "running" | "completed" | "failed" | "cancelled"

export type Submission = {
  id: string
  team_id: string
  challenge_id: string
  attempt_no: number
  block_program: unknown
  status: SubmissionStatus
  queue_order: number
  priority: number
  result_image_asset_id: string | null
  result_image_path: string | null
  result_image_url: string | null
  trace: unknown | null
  similarity: number | null
  passed: boolean | null
  judge_score: number | null
  awarded_points: number | null
  error_message: string | null
  retry_of: string | null
  created_at: Timestamp
  updated_at: Timestamp
  started_at: Timestamp | null
  completed_at: Timestamp | null
  cancelled_at: Timestamp | null
}

export type QueueEntry = {
  submission: Submission
  position: number
}

export type MyQueueResponse = {
  paused: boolean
  queued_submissions: QueueEntry[]
  running_submission: QueueEntry | null
}

export type SubmissionCreatedResponse = {
  submission: Submission
  position: number | null
}

export type ScoreEventType =
  | "challenge_pass"
  | "admin_add"
  | "admin_subtract"
  | "admin_set"
  | "admin_adjust"
  | "recalculation"

export type ScoreEvent = {
  id: string
  team_id: string
  type: ScoreEventType
  score_before: number
  score_after: number
  delta: number
  refs: {
    challenge_id: string | null
    submission_id: string | null
  }
  reason: string | null
  created_by: string | null
  created_at: Timestamp
}

export type LeaderboardEntry = {
  rank: number
  team_id: string
  team_name: string
  total_score: number
  solved_count: number
  last_score_event_at: Timestamp | null
}

export type LeaderboardResponse = {
  teams: LeaderboardEntry[]
  updated_at: Timestamp
}

export type AppEvent =
  | {
      type: "score_recorded"
      score_event: ScoreEvent
    }
  | {
      type: "submission_updated"
      submission_id: string
    }
  | {
      type: "judging_started"
      submission_id: string
      team_id: string
      challenge_id: string
      canvas_width: number
      canvas_height: number
      step_count: number
    }
  | {
      type: "judging_step"
      submission_id: string
      team_id: string
      challenge_id: string
      canvas_width: number
      canvas_height: number
      step: unknown
      playback_ms: number
    }
  | {
      type: "judging_completed"
      submission_id: string
      team_id: string
      challenge_id: string
    }
