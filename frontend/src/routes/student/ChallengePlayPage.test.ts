import { describe, expect, it, vi } from "vitest"

import { createWorkspaceFromXml } from "../../lib/blockly"
import type { MyQueueResponse, Submission } from "../../lib/student/types"

import {
  buildWorkspaceProgramSnapshot,
  queueItemsForChallenge,
  submitWorkspaceProgram,
} from "./ChallengePlayPage.logic"

const canvas = {
  width: 100,
  height: 80,
  background_color: "#ffffff",
}

describe("ChallengePlayPage logic", () => {
  it("serializes a Blockly workspace and adapts it for execute preview", () => {
    const workspace = createWorkspaceFromXml(`
      <xml xmlns="https://developers.google.com/blockly/xml">
        <block type="turtle_move_right" id="move-right">
          <field name="DISTANCE">12</field>
        </block>
      </xml>
    `)

    const snapshot = buildWorkspaceProgramSnapshot(workspace, canvas)

    expect(snapshot.xml).toContain("turtle_move_right")
    expect(snapshot.program).toMatchObject({
      version: 1,
      canvas: { width: 100, height: 80 },
      start: { x: 50, y: 40, heading: 0, pen_down: true },
      blocks: [
        { type: "set_heading", args: { degrees: 0 } },
        { id: "move-right", type: "forward", args: { distance: 12 } },
      ],
    })
  })

  it("submits the adapted backend program for the selected challenge", async () => {
    const workspace = createWorkspaceFromXml(`
      <xml xmlns="https://developers.google.com/blockly/xml">
        <block type="turtle_move_up" id="move-up">
          <field name="DISTANCE">7</field>
        </block>
      </xml>
    `)
    const createSubmission = vi.fn(async (_challengeId, blockProgram) => ({
      submission: makeSubmission("current-challenge", "queued"),
      position: 2,
      blockProgram,
    }))

    const result = await submitWorkspaceProgram({
      workspace,
      canvas,
      challengeId: "current-challenge",
      createSubmission,
    })

    expect(createSubmission).toHaveBeenCalledWith(
      "current-challenge",
      expect.objectContaining({
        blocks: [
          expect.objectContaining({ type: "set_heading", args: { degrees: 90 } }),
          expect.objectContaining({ type: "forward", args: { distance: 7 } }),
        ],
      }),
    )
    expect(result.response.position).toBe(2)
    expect(result.program.blocks).toHaveLength(2)
  })

  it("filters the team queue to the selected challenge only", () => {
    const queue: MyQueueResponse = {
      paused: false,
      running_submission: {
        submission: makeSubmission("current-challenge", "running", "running-current"),
        position: 0,
      },
      queued_submissions: [
        {
          submission: makeSubmission("other-challenge", "queued", "queued-other"),
          position: 1,
        },
        {
          submission: makeSubmission("current-challenge", "queued", "queued-current"),
          position: 2,
        },
      ],
    }

    expect(queueItemsForChallenge(queue, "current-challenge").map((item) => item.submission.id)).toEqual([
      "running-current",
      "queued-current",
    ])
  })
})

function makeSubmission(
  challengeId: string,
  status: Submission["status"],
  id = `${challengeId}-${status}`,
): Submission {
  return {
    id,
    team_id: "team-1",
    challenge_id: challengeId,
    attempt_no: 1,
    block_program: null,
    status,
    queue_order: 1,
    priority: 0,
    result_image_asset_id: null,
    result_image_path: null,
    result_image_url: null,
    trace: null,
    similarity: null,
    passed: null,
    judge_score: null,
    awarded_points: null,
    error_message: null,
    retry_of: null,
    created_at: "2026-06-23T00:00:00Z",
    updated_at: "2026-06-23T00:00:00Z",
    started_at: null,
    completed_at: null,
    cancelled_at: null,
  }
}
