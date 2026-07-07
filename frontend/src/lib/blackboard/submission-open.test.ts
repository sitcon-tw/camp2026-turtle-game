import { describe, expect, it } from "vitest"

import type { BlackboardState, BlackboardTeam, GameSubmission, GameSubmissionStatus } from "@/lib/game/types"

import {
  parseBlackboardEventData,
  playbackCueFromBlackboardEvent,
  previewCueFromBlackboardEvent,
  selectedPreviewRunForSubmissionOpen,
  selectedSubmissionForSubmissionOpen,
  submissionOpenCountItems,
} from "./submission-open"

const teams: BlackboardTeam[] = [
  { id: "team-a", name: "Alpha", enabled: true, total_score: 0 },
  { id: "team-b", name: "Beta", enabled: true, total_score: 0 },
  { id: "team-c", name: "Gamma", enabled: true, total_score: 0 },
]

describe("submission-open blackboard helpers", () => {
  it("only creates playback cues from admin blackboard events", () => {
    expect(playbackCueFromBlackboardEvent({ type: "judging_started", submission_id: "submission-a" }, 1000)).toBeNull()
    expect(playbackCueFromBlackboardEvent({ type: "submission_updated", submission_id: "submission-a" }, 1000)).toBeNull()

    expect(
      playbackCueFromBlackboardEvent(
        parseBlackboardEventData(JSON.stringify({ type: "blackboard_playback_changed", submission_id: "submission-a" })),
        1000,
      ),
    ).toEqual({
      submissionId: "submission-a",
      animationKey: "submission-a:1000",
    })

    expect(
      playbackCueFromBlackboardEvent(
        parseBlackboardEventData(JSON.stringify({ type: "blackboard_playback_changed", submission_id: null })),
        1001,
      ),
    ).toEqual({
      submissionId: null,
      animationKey: "none:1001",
    })
    expect(parseBlackboardEventData("not json")).toBeNull()
  })

  it("builds per-team submission counts without showing latest artwork", () => {
    const items = submissionOpenCountItems(teams, [
      submission({ id: "a-1", team_id: "team-a", status: "completed" }),
      submission({ id: "a-2", team_id: "team-a", status: "queued" }),
      submission({ id: "a-3", team_id: "team-a", status: "running" }),
      submission({ id: "b-1", team_id: "team-b", status: "completed" }),
      submission({ id: "b-2", team_id: "team-b", status: "failed" }),
      submission({ id: "b-3", team_id: "team-b", status: "cancelled" }),
    ])

    expect(items).toEqual([
      {
        team: teams[0],
        stats: { total: 3, completed: 1, active: 2, failed: 0 },
      },
      {
        team: teams[1],
        stats: { total: 3, completed: 1, active: 0, failed: 2 },
      },
      {
        team: teams[2],
        stats: { total: 0, completed: 0, active: 0, failed: 0 },
      },
    ])
  })

  it("uses exactly one selected submission and lets clear cues win over stale state", () => {
    const submissions = [
      submission({ id: "submission-a", team_id: "team-a", status: "completed" }),
      submission({ id: "submission-b", team_id: "team-b", status: "completed" }),
    ]
    const state = blackboardState(submissions, "submission-a")

    expect(selectedSubmissionForSubmissionOpen(state, null)).toEqual({
      submission: submissions[0],
      animationKey: "blackboard-selected:submission-a",
    })
    expect(
      selectedSubmissionForSubmissionOpen(state, {
        submissionId: "submission-b",
        animationKey: "submission-b:2000",
      }),
    ).toEqual({
      submission: submissions[1],
      animationKey: "submission-b:2000",
    })
    expect(
      selectedSubmissionForSubmissionOpen(state, {
        submissionId: null,
        animationKey: "none:2001",
      }),
    ).toBeNull()
    expect(selectedSubmissionForSubmissionOpen(blackboardState(submissions, "stale-submission"), null)).toBeNull()
  })

  it("uses selected preview runs and lets preview clear cues win over stale state", () => {
    const state = blackboardState([], null)
    state.display.mode = "preview"
    state.display.selected_preview_run_id = "preview-a"
    state.preview_sessions = [
      {
        session_id: "session-a",
        team_id: "team-a",
        device_id: "device-a",
        label: "Session 1",
        latest_preview_at: "2026-07-04T00:00:02.000Z",
        runs: [
          previewRun({ id: "preview-a", session_id: "session-a", team_id: "team-a" }),
          previewRun({ id: "preview-b", session_id: "session-a", team_id: "team-a" }),
        ],
      },
    ]

    expect(previewCueFromBlackboardEvent({ type: "blackboard_playback_changed", preview_run_id: "preview-a" }, 1000)).toBeNull()
    expect(
      previewCueFromBlackboardEvent(
        parseBlackboardEventData(JSON.stringify({ type: "blackboard_preview_playback_changed", preview_run_id: "preview-b" })),
        2000,
      ),
    ).toEqual({
      previewRunId: "preview-b",
      animationKey: "preview:preview-b:2000",
    })
    expect(selectedPreviewRunForSubmissionOpen(state, null)).toEqual({
      previewRun: state.preview_sessions[0].runs[0],
      animationKey: "blackboard-selected-preview:preview-a",
    })
    expect(
      selectedPreviewRunForSubmissionOpen(state, {
        previewRunId: "preview-b",
        animationKey: "preview:preview-b:2001",
      }),
    ).toEqual({
      previewRun: state.preview_sessions[0].runs[1],
      animationKey: "preview:preview-b:2001",
    })
    expect(
      selectedPreviewRunForSubmissionOpen(state, {
        previewRunId: null,
        animationKey: "preview:none:2002",
      }),
    ).toBeNull()
    state.display.selected_preview_run_id = "stale-preview"
    expect(selectedPreviewRunForSubmissionOpen(state, null)).toBeNull()
  })
})

function submission(input: {
  id: string
  team_id: string
  status: GameSubmissionStatus
  attempt_no?: number
}): GameSubmission {
  return {
    id: input.id,
    team_id: input.team_id,
    challenge_id: "challenge-a",
    attempt_no: input.attempt_no ?? 1,
    block_program: {},
    status: input.status,
    queue_order: 0,
    priority: 0,
    result_image_asset_id: null,
    result_image_path: null,
    result_image_url: null,
    trace: null,
    error_message: null,
    retry_of: null,
    created_at: "2026-07-04T00:00:00.000Z",
    updated_at: "2026-07-04T00:00:00.000Z",
    started_at: null,
    completed_at: input.status === "completed" ? "2026-07-04T00:00:01.000Z" : null,
    cancelled_at: input.status === "cancelled" ? "2026-07-04T00:00:01.000Z" : null,
  }
}

function previewRun(input: {
  id: string
  session_id: string
  team_id: string
}) {
  return {
    id: input.id,
    round_id: "round-a",
    challenge_id: "challenge-a",
    team_id: input.team_id,
    session_id: input.session_id,
    device_id: "device-a",
    block_program: {},
    created_at: "2026-07-04T00:00:02.000Z",
  }
}

function blackboardState(roundSubmissions: GameSubmission[], selectedSubmissionId: string | null): BlackboardState {
  return {
    status: "idle",
    display: {
      mode: "submission",
      selected_submission_id: selectedSubmissionId,
      selected_stream_session_id: null,
      selected_preview_run_id: null,
    },
    selected_submission_id: selectedSubmissionId,
    game: {
      state: {
        version: 1,
        phase: "submission_open",
        current_round_id: "round-a",
        current_challenge_id: "challenge-a",
        phase_started_at: "2026-07-04T00:00:00.000Z",
        phase_ends_at: "2026-07-04T00:10:00.000Z",
        public_votes_per_team: 3,
        team_selection_seconds: 60,
        updated_at: "2026-07-04T00:00:00.000Z",
        updated_by: "admin",
        server_now: "2026-07-04T00:00:00.000Z",
      },
      round: null,
      challenge: null,
      round_submissions: roundSubmissions,
      my_submissions: [],
      nominations: [],
      my_team_selection_vote: null,
      my_public_vote: null,
      public_vote_counts: [],
      results: [],
    },
    teams,
    stream_sessions: [],
    preview_sessions: [],
    leaderboard: [],
  }
}
