export type Role = "team" | "admin"
export type Timestamp = string
export type ChallengeSetStatus = "draft" | "active" | "archived"

export type ApiErrorBody = {
  error: {
    code: string
    message: string
    details: unknown | null
  }
}

export type AdminLoginResponse = {
  access_token: string
  role: Role
  subject: string
}

export type AdminMeResponse = {
  role: Role
  subject: string
}

export type Team = {
  id: string
  name: string
  login_code: string
  enabled: boolean
  note: string | null
  total_score: number
  created_at: Timestamp
  updated_at: Timestamp
}

export type CanvasConfig = {
  width: number
  height: number
  background_color: string
}

export type ChallengeSet = {
  id: string
  name: string
  version: string
  status: ChallengeSetStatus
  challenge_count?: number
  created_at: Timestamp
  updated_at: Timestamp
}

export type ChallengeStats = {
  submission_count: number
  solved_count: number
}

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
  enabled: boolean
  order: number
  canvas: CanvasConfig
  judge_config: unknown
  stats?: ChallengeStats
  created_at: Timestamp
  updated_at: Timestamp
}

export type ReadinessResponse = {
  ok: boolean
  database: string
  storage: string
}
