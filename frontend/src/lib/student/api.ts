import { clearTeamToken, getTeamToken } from "@/lib/student/session"
import type { GameStateResponse, GameSubmission, LeaderboardResponse, PublicVoteChoice } from "@/lib/game/types"
import type {
  ApiErrorBody,
  Team,
  TeamLoginResponse,
} from "@/lib/student/types"

export class StudentApiError extends Error {
  code: string
  status: number
  details: unknown | null

  constructor(status: number, code: string, message: string, details: unknown | null) {
    super(message)
    this.name = "StudentApiError"
    this.status = status
    this.code = code
    this.details = details
  }
}

type RequestOptions = RequestInit & { auth?: boolean }

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const headers = new Headers(options.headers)
  const isFormData = options.body instanceof FormData
  if (options.body && !isFormData && !headers.has("content-type")) {
    headers.set("content-type", "application/json")
  }
  if (options.auth !== false) {
    const token = getTeamToken()
    if (token) headers.set("authorization", `Bearer ${token}`)
  }

  const response = await fetch(path, { ...options, headers })
  if (!response.ok) {
    let code = "request_failed"
    let message = `請求失敗，狀態碼 ${response.status}`
    let details: unknown | null = null
    try {
      const body = (await response.json()) as ApiErrorBody
      code = body.error.code
      message = body.error.message
      details = body.error.details
    } catch {
      // keep generic error
    }
    if (response.status === 401) clearTeamToken()
    throw new StudentApiError(response.status, code, message, details)
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

export const studentApi = {
  login(code: string) {
    return request<TeamLoginResponse>("/api/v1/team/login", {
      method: "POST",
      auth: false,
      body: jsonBody({ code }),
    })
  },
  me() {
    return request<Team>("/api/v1/me")
  },
  leaderboard() {
    return request<LeaderboardResponse>("/api/v1/leaderboard", { auth: false })
  },
  gameState() {
    return request<GameStateResponse>("/api/v1/game/state")
  },
  createCurrentRoundSubmission(blockProgram: unknown) {
    return request<{ submission: GameSubmission }>("/api/v1/game/rounds/current/submissions", {
      method: "POST",
      body: jsonBody({ block_program: blockProgram }),
    })
  },
  recordTeamSelectionVote(submissionId: string, deviceId: string) {
    return request<TeamSelectionVoteResponse>("/api/v1/game/rounds/current/team-selection-votes", {
      method: "POST",
      headers: { "x-device-id": deviceId },
      body: jsonBody({ submission_id: submissionId }),
    })
  },
  recordPublicVote(votes: PublicVoteChoice[]) {
    return request<PublicVoteResponse>("/api/v1/game/rounds/current/public-votes", {
      method: "POST",
      body: jsonBody({ votes }),
    })
  },
}

type TeamSelectionVoteResponse = GameStateResponse["my_team_selection_vote"] extends infer Vote
  ? NonNullable<Vote>
  : never

type PublicVoteResponse = GameStateResponse["my_public_vote"] extends infer Vote ? NonNullable<Vote> : never

export function studentErrorMessage(error: unknown) {
  if (error instanceof StudentApiError) {
    switch (error.code) {
      case "invalid_team_code":
        return "隊伍登入碼不正確，請確認後再試一次。"
      case "team_disabled":
        return "這個隊伍目前已停用，請聯絡工作人員。"
      case "unauthorized":
        return "登入狀態已失效，請重新登入。"
      case "forbidden":
        return "目前沒有權限執行此操作。"
      case "not_found":
        return "找不到指定的資料。"
      case "too_many_requests":
        return "送出太頻繁了，請稍候再試。"
      default:
        return error.message || "操作失敗，請稍候再試。"
    }
  }
  return error instanceof Error ? error.message : "發生未知錯誤，請稍候再試。"
}

export const errorMessage = studentErrorMessage
