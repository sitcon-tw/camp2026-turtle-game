import { clearAdminToken, getAdminToken } from "@/lib/admin/session"
import type {
  AdminLoginResponse,
  AdminMeResponse,
  ApiErrorBody,
  Challenge,
  ChallengeSet,
  ReadinessResponse,
  Team,
} from "@/lib/admin/types"
import type {
  BlackboardControlState,
  BlackboardDisplayMode,
  BlackboardState,
  GamePhase,
  GameStateResponse,
  LeaderboardResponse,
} from "@/lib/game/types"

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
    return request<Team>(`/api/v1/admin/teams/${id}`, { method: "PATCH", body: jsonBody({ enabled: false }) })
  },
  enableTeam(id: string) {
    return request<Team>(`/api/v1/admin/teams/${id}`, { method: "PATCH", body: jsonBody({ enabled: true }) })
  },
  deleteTeam(id: string) {
    return request<{ deleted: boolean; team_id: string; deleted_submission_count: number }>(
      `/api/v1/admin/teams/${id}`,
      { method: "DELETE" },
    )
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
  importChallengeSet(file: File) {
    const data = new FormData()
    data.append("file", file)
    return request<ChallengeSet>("/api/v1/admin/challenge-sets/import", { method: "POST", body: data })
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
  challenges(filters: { challenge_set_id?: string; active_only?: boolean }) {
    return request<Challenge[]>(`/api/v1/admin/challenges${query(filters)}`)
  },
  createChallenge(setId: string, input: {
    slug: string
    title: string
    description: string
    points: number
    enabled: boolean
    order: number
  }) {
    return request<Challenge>(`/api/v1/admin/challenge-sets/${setId}/challenges`, {
      method: "POST",
      body: jsonBody(input),
    })
  },
  updateChallenge(
    id: string,
    input: Partial<Pick<Challenge, "title" | "description" | "points" | "enabled" | "order">>,
  ) {
    return request<Challenge>(`/api/v1/admin/challenges/${id}`, { method: "PATCH", body: jsonBody(input) })
  },
  disableChallenge(id: string) {
    return request<Challenge>(`/api/v1/admin/challenges/${id}`, { method: "DELETE" })
  },
  uploadChallengeTargetImage(id: string, file: File) {
    const data = new FormData()
    data.append("file", file)
    return request<Challenge>(`/api/v1/admin/challenges/${id}/target-image`, { method: "POST", body: data })
  },
  reorderChallenges(items: Array<{ challenge_id: string; order: number }>) {
    return request<Challenge[]>("/api/v1/admin/challenges/reorder", { method: "POST", body: jsonBody({ items }) })
  },
  gameState() {
    return request<GameStateResponse>("/api/v1/game/state")
  },
  startRound(input: { challenge_id: string; submission_seconds: number; public_votes_per_team: number }) {
    return request<GameStateResponse>("/api/v1/admin/game/rounds", {
      method: "POST",
      body: jsonBody(input),
    })
  },
  updateGameTimer(input: { phase_ends_at?: string; add_seconds?: number }) {
    return request<GameStateResponse>("/api/v1/admin/game/timer", {
      method: "PATCH",
      body: jsonBody(input),
    })
  },
  setGamePhase(phase: GamePhase) {
    return request<GameStateResponse>("/api/v1/admin/game/phase", {
      method: "POST",
      body: jsonBody({ phase }),
    })
  },
  scoreCurrentRound() {
    return request<GameStateResponse>("/api/v1/admin/game/score", { method: "POST", body: jsonBody({}) })
  },
  playSubmissionOnBlackboard(submissionId: string) {
    return request<{ played: boolean; submission_id: string }>(
      `/api/v1/admin/submissions/${submissionId}/blackboard-playback`,
      { method: "POST", body: jsonBody({}) },
    )
  },
  clearBlackboardPlayback() {
    return request<{ selected_submission_id: string | null }>("/api/v1/admin/blackboard/playback", {
      method: "DELETE",
    })
  },
  blackboardControl() {
    return request<BlackboardControlState>("/api/v1/admin/blackboard/control")
  },
  setBlackboardDisplay(input: {
    mode: BlackboardDisplayMode
    submission_id?: string | null
    stream_session_id?: string | null
    preview_run_id?: string | null
  }) {
    return request<BlackboardControlState>("/api/v1/admin/blackboard/display", {
      method: "POST",
      body: jsonBody(input),
    })
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
