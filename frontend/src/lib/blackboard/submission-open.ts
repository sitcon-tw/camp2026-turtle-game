import type { BlackboardState, BlackboardTeam, GameSubmission } from "@/lib/game/types"

export type BlackboardReplay = {
  submissionId: string | null
  animationKey: string
}

export type BlackboardEventPayload = {
  type?: string
  submission_id?: string | null
}

export type SubmissionCounts = {
  total: number
  completed: number
  active: number
  failed: number
}

export type TeamSubmissionCount = {
  team: BlackboardTeam
  stats: SubmissionCounts
}

const EMPTY_SUBMISSION_COUNTS: SubmissionCounts = {
  total: 0,
  completed: 0,
  active: 0,
  failed: 0,
}

export function parseBlackboardEventData(data: unknown): BlackboardEventPayload | null {
  try {
    return JSON.parse(String(data)) as BlackboardEventPayload
  } catch {
    return null
  }
}

export function playbackCueFromBlackboardEvent(
  event: BlackboardEventPayload | null,
  now = Date.now(),
): BlackboardReplay | null {
  if (event?.type !== "blackboard_playback_changed") return null

  return {
    submissionId: event.submission_id ?? null,
    animationKey: `${event.submission_id ?? "none"}:${now}`,
  }
}

export function submissionOpenCountItems(
  teams: BlackboardTeam[],
  submissions: GameSubmission[],
): TeamSubmissionCount[] {
  const countsByTeam = submissionCountsByTeam(submissions)
  return teams.map((team) => ({
    team,
    stats: countsByTeam.get(team.id) ?? emptySubmissionCounts(),
  }))
}

export function selectedSubmissionForSubmissionOpen(
  data: BlackboardState,
  playbackCue: BlackboardReplay | null,
) {
  const selectedSubmissionId = playbackCue ? playbackCue.submissionId : data.selected_submission_id
  const submission = selectedSubmissionId
    ? data.game.round_submissions.find((item) => item.id === selectedSubmissionId) ?? null
    : null

  if (!submission) return null

  return {
    submission,
    animationKey:
      playbackCue && playbackCue.submissionId === selectedSubmissionId
        ? playbackCue.animationKey
        : `blackboard-selected:${selectedSubmissionId}`,
  }
}

function emptySubmissionCounts() {
  return { ...EMPTY_SUBMISSION_COUNTS }
}

function submissionCountsByTeam(submissions: GameSubmission[]) {
  const counts = new Map<string, SubmissionCounts>()
  for (const submission of submissions) {
    const current = counts.get(submission.team_id) ?? {
      total: 0,
      completed: 0,
      active: 0,
      failed: 0,
    }
    current.total += 1
    if (submission.status === "completed") current.completed += 1
    if (submission.status === "queued" || submission.status === "running") current.active += 1
    if (submission.status === "failed" || submission.status === "cancelled") current.failed += 1
    counts.set(submission.team_id, current)
  }
  return counts
}
