import { clearAdminToken, getAdminToken } from "@/lib/admin/session"
import type {
  AdminLoginResponse,
  AdminMeResponse,
  AdminTeamDetails,
  ApiErrorBody,
  BlackboardState,
  Challenge,
  ChallengeSet,
  JudgeQueueResponse,
  LeaderboardResponse,
  ReadinessResponse,
  ScoreEvent,
  ScoreEventType,
  Submission,
  SubmissionStatus,
  Team,
} from "@/lib/admin/types"

export class AdminApiError extends Error {
  code: string
  status: number
  details: unknown | null

  constructor(status: number, code: string, message: string, details: unknown | null) {
    super(message)
    this.name = "AdminApiError"
    this.status = status
    this.code = code
    this.details = details
  }
}

type RequestOptions = RequestInit & { admin?: boolean }

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const headers = new Headers(options.headers)
  const isFormData = options.body instanceof FormData
  if (options.body && !isFormData && !headers.has("content-type")) {
    headers.set("content-type", "application/json")
  }
  if (options.admin !== false) {
    const token = getAdminToken()
    if (token) headers.set("authorization", `Bearer ${token}`)
  }

  const response = await fetch(path, { ...options, headers })
  if (!response.ok) {
    let code = "request_failed"
    let message = `Request failed with status ${response.status}`
    let details: unknown | null = null
    try {
      const body = (await response.json()) as ApiErrorBody
      code = body.error.code
      message = body.error.message
      details = body.error.details
    } catch {
      // keep generic error
    }
    if (response.status === 401) clearAdminToken()
    throw new AdminApiError(response.status, code, message, details)
  }

  const contentType = response.headers.get("content-type") ?? ""
  if (!contentType.includes("application/json")) {
    return response.blob() as Promise<T>
  }
  return response.json() as Promise<T>
}

function jsonBody(value: unknown) {
  return JSON.stringify(value)
}

function query(params: Record<string, string | number | boolean | null | undefined>) {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") search.set(key, String(value))
  }
  const value = search.toString()
  return value ? `?${value}` : ""
}

export const adminApi = {
  login(password: string) {
    return request<AdminLoginResponse>("/api/v1/admin/login", {
      method: "POST",
      admin: false,
      body: jsonBody({ password }),
    })
  },
  me() {
    return request<AdminMeResponse>("/api/v1/admin/me")
  },
  health() {
    return request<{ ok: boolean }>("/healthz", { admin: false })
  },
  readiness() {
    return request<ReadinessResponse>("/readyz", { admin: false })
  },
  teams(filters: { enabled?: boolean | null; search?: string }) {
    return request<Team[]>(`/api/v1/admin/teams${query(filters)}`)
  },
  team(id: string) {
    return request<AdminTeamDetails>(`/api/v1/admin/teams/${id}`)
  },
  createTeam(input: { name: string; login_code?: string; note?: string }) {
    return request<Team>("/api/v1/admin/teams", { method: "POST", body: jsonBody(input) })
  },
  bulkCreateTeams(teams: Array<{ name: string; login_code?: string; note?: string }>) {
    return request<{ teams: Team[] }>("/api/v1/admin/teams/bulk-create", {
      method: "POST",
      body: jsonBody({ teams }),
    })
  },
  updateTeam(id: string, input: { name?: string; login_code?: string; enabled?: boolean; note?: string | null }) {
    return request<Team>(`/api/v1/admin/teams/${id}`, { method: "PATCH", body: jsonBody(input) })
  },
  disableTeam(id: string) {
    return request<{ disabled: boolean; team: Team }>(`/api/v1/admin/teams/${id}`, { method: "DELETE" })
  },
  rotateTeamCode(id: string) {
    return request<{ team: Team; login_code: string }>(`/api/v1/admin/teams/${id}/rotate-code`, { method: "POST" })
  },
  challengeSets() {
    return request<ChallengeSet[]>("/api/v1/admin/challenge-sets")
  },
  challengeSet(id: string) {
    return request<ChallengeSet & { challenges: Challenge[] }>(`/api/v1/admin/challenge-sets/${id}`)
  },
  createChallengeSet(input: { name: string; version: string }) {
    return request<ChallengeSet>("/api/v1/admin/challenge-sets", { method: "POST", body: jsonBody(input) })
  },
  activateChallengeSet(id: string) {
    return request<ChallengeSet>(`/api/v1/admin/challenge-sets/${id}/activate`, { method: "POST" })
  },
  archiveChallengeSet(id: string) {
    return request<ChallengeSet>(`/api/v1/admin/challenge-sets/${id}/archive`, { method: "POST" })
  },
  exportChallengeSet(id: string) {
    return request<Blob>(`/api/v1/admin/challenge-sets/${id}/export`)
  },
  importChallengeSet(file: File) {
    const data = new FormData()
    data.append("file", file)
    return request<ChallengeSet>("/api/v1/admin/challenge-sets/import", { method: "POST", body: data })
  },
  challenges(filters: { challenge_set_id?: string; active_only?: boolean }) {
    return request<Challenge[]>(`/api/v1/admin/challenges${query(filters)}`)
  },
  challenge(id: string) {
    return request<Challenge>(`/api/v1/admin/challenges/${id}`)
  },
  createChallenge(setId: string, input: {
    slug: string
    title: string
    description: string
    points: number
    pass_threshold: number
    enabled: boolean
    order: number
  }) {
    return request<Challenge>(`/api/v1/admin/challenge-sets/${setId}/challenges`, {
      method: "POST",
      body: jsonBody(input),
    })
  },
  updateChallenge(id: string, input: Partial<Pick<Challenge, "title" | "description" | "points" | "pass_threshold" | "enabled" | "order">>) {
    return request<Challenge>(`/api/v1/admin/challenges/${id}`, { method: "PATCH", body: jsonBody(input) })
  },
  disableChallenge(id: string) {
    return request<Challenge>(`/api/v1/admin/challenges/${id}`, { method: "DELETE" })
  },
  uploadChallengeImage(id: string, file: File) {
    const data = new FormData()
    data.append("file", file)
    return request<Challenge>(`/api/v1/admin/challenges/${id}/target-image`, { method: "POST", body: data })
  },
  reorderChallenges(items: Array<{ challenge_id: string; order: number }>) {
    return request<Challenge[]>("/api/v1/admin/challenges/reorder", { method: "POST", body: jsonBody({ items }) })
  },
  submissions(filters: { team_id?: string; challenge_id?: string; status?: SubmissionStatus | "" }) {
    return request<Submission[]>(`/api/v1/admin/submissions${query(filters)}`)
  },
  submission(id: string) {
    return request<Submission>(`/api/v1/admin/submissions/${id}`)
  },
  retrySubmission(id: string) {
    return request<{ submission: Submission; position: number | null }>(`/api/v1/admin/submissions/${id}/retry`, { method: "POST" })
  },
  cancelSubmission(id: string) {
    return request<Submission>(`/api/v1/admin/submissions/${id}/cancel`, { method: "POST" })
  },
  judgeQueue() {
    return request<JudgeQueueResponse>("/api/v1/admin/judge-queue")
  },
  pauseQueue() {
    return request<{ paused: boolean }>("/api/v1/admin/judge-queue/pause", { method: "POST" })
  },
  resumeQueue() {
    return request<{ paused: boolean }>("/api/v1/admin/judge-queue/resume", { method: "POST" })
  },
  prioritizeSubmission(id: string, position: number) {
    return request<Submission>(`/api/v1/admin/judge-queue/${id}/prioritize`, {
      method: "POST",
      body: jsonBody({ position }),
    })
  },
  scoreEvents(filters: { team_id?: string; challenge_id?: string; type?: ScoreEventType | "" }) {
    return request<ScoreEvent[]>(`/api/v1/admin/score-events${query(filters)}`)
  },
  bulkAdjustScores(input:
    | { operation: "add"; team_ids: string[]; amount: number; reason: string }
    | { operation: "subtract"; team_ids: string[]; amount: number; reason: string }
    | { operation: "set"; team_ids: string[]; target_score: number; reason: string }
  ) {
    return request<{ updated_teams: Array<{ team_id: string; score_before: number; score_after: number; delta: number; score_event_id: string }> }>(
      "/api/v1/admin/scores/bulk-adjust",
      { method: "POST", body: jsonBody(input) },
    )
  },
  recalculateScores() {
    return request<{ teams: Team[] }>("/api/v1/admin/scores/recalculate", { method: "POST" })
  },
  recalculateChallengeAwards() {
    return request<{ teams: Team[] }>("/api/v1/admin/scores/recalculate-challenge-awards", { method: "POST" })
  },
  leaderboard() {
    return request<LeaderboardResponse>("/api/v1/leaderboard", { admin: false })
  },
  blackboard() {
    return request<BlackboardState>("/api/v1/blackboard/state", { admin: false })
  },
}

export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Unexpected error"
}
