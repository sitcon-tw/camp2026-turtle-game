export type Timestamp = string

export type GamePhase =
  | "idle"
  | "submission_open"
  | "team_selection"
  | "public_voting"
  | "scoring"
  | "round_complete"

export type CanvasConfig = {
  width: number
  height: number
  background_color: string
}

export type GameChallenge = {
  id: string
  challenge_set_id: string
  slug: string
  title: string
  description: string
  target_image_asset_id: string | null
  target_image_path: string | null
  target_image_url: string | null
  points: number
  enabled: boolean
  order: number
  canvas: CanvasConfig
  judge_config: unknown
  created_at: Timestamp
  updated_at: Timestamp
}

export type GameSubmissionStatus = "queued" | "running" | "completed" | "failed" | "cancelled"

export type GameSubmission = {
  id: string
  team_id: string
  challenge_id: string
  attempt_no: number
  block_program: unknown
  status: GameSubmissionStatus
  queue_order: number
  priority: number
  result_image_asset_id: string | null
  result_image_path: string | null
  result_image_url: string | null
  trace: unknown | null
  error_message: string | null
  retry_of: string | null
  created_at: Timestamp
  updated_at: Timestamp
  started_at: Timestamp | null
  completed_at: Timestamp | null
  cancelled_at: Timestamp | null
}

export type Round = {
  id: string
  challenge_id: string
  started_at: Timestamp
  submission_ends_at: Timestamp
  team_selection_ends_at: Timestamp | null
  public_voting_ends_at: Timestamp | null
  completed_at: Timestamp | null
}

export type GameStateView = {
  version: number
  phase: GamePhase
  current_round_id: string | null
  current_challenge_id: string | null
  phase_started_at: Timestamp
  phase_ends_at: Timestamp | null
  public_votes_per_team: number
  team_selection_seconds: number
  updated_at: Timestamp
  updated_by: string | null
  server_now: Timestamp
}

export type TeamSelectionVote = {
  round_id: string
  team_id: string
  device_id: string
  submission_id: string
  created_at: Timestamp
  updated_at: Timestamp
}

export type TeamNomination = {
  round_id: string
  team_id: string
  submission_id: string
  vote_count: number
  selected_at: Timestamp
}

export type PublicVoteChoice = {
  target_team_id: string
  target_submission_id: string
  rank: number
}

export type PublicVote = {
  round_id: string
  voter_team_id: string
  choices: PublicVoteChoice[]
  created_at: Timestamp
  updated_at: Timestamp
}

export type PublicVoteCount = {
  target_team_id: string
  target_submission_id: string
  vote_count: number
}

export type RoundResultEntry = {
  rank: number
  team_id: string
  submission_id: string
  vote_count: number
  placement_points: number
  streak: number
  streak_bonus: number
}

export type GameStateResponse = {
  state: GameStateView
  round: Round | null
  challenge: GameChallenge | null
  round_submissions: GameSubmission[]
  my_submissions: GameSubmission[]
  nominations: TeamNomination[]
  my_team_selection_vote: TeamSelectionVote | null
  my_public_vote: PublicVote | null
  public_vote_counts: PublicVoteCount[]
  results: RoundResultEntry[]
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

export type BlackboardTeam = {
  id: string
  name: string
  enabled: boolean
  total_score: number
}

export type BlackboardState = {
  status: "idle"
  display: BlackboardDisplay
  selected_submission_id: string | null
  game: GameStateResponse
  teams: BlackboardTeam[]
  stream_sessions: BlackboardStreamSession[]
  preview_sessions: BlackboardPreviewSession[]
  leaderboard: LeaderboardEntry[]
}

export type BlackboardDisplayMode = "submission" | "stream" | "preview"

export type BlackboardDisplay = {
  mode: BlackboardDisplayMode
  selected_submission_id: string | null
  selected_stream_session_id: string | null
  selected_preview_run_id: string | null
}

export type BlackboardStreamSession = {
  session_id: string
  team_id: string
  device_id: string
  label: string
  connected: boolean
  last_seen_at: Timestamp
}

export type BlackboardPreviewRun = {
  id: string
  round_id: string
  challenge_id: string
  team_id: string
  session_id: string
  device_id: string
  block_program: unknown
  created_at: Timestamp
}

export type BlackboardPreviewSession = {
  session_id: string
  team_id: string
  device_id: string
  label: string
  latest_preview_at: Timestamp
  runs: BlackboardPreviewRun[]
}

export type BlackboardControlState = {
  display: BlackboardDisplay
  selected_submission_id: string | null
  stream_sessions: BlackboardStreamSession[]
  preview_sessions: BlackboardPreviewSession[]
}
