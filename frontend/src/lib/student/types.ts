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

