import type { Workspace } from "blockly/core"

import {
  serializeWorkspaceToXml,
  workspaceToBackendProgram,
  type BackendBlockProgram,
  type ChallengeCanvas,
} from "../../lib/blockly"
import type { MyQueueResponse, Submission, SubmissionCreatedResponse, SubmissionStatus } from "../../lib/student/types"

export type WorkspaceProgramSnapshot = {
  xml: string
  program: BackendBlockProgram
}

export type CurrentChallengeQueueItem = {
  submission: Submission
  position: number
  status: SubmissionStatus
}

export type SubmitWorkspaceProgramOptions = {
  workspace: Workspace
  canvas: ChallengeCanvas
  challengeId: string
  createSubmission: (challengeId: string, blockProgram: BackendBlockProgram) => Promise<SubmissionCreatedResponse>
}

export function buildWorkspaceProgramSnapshot(
  workspace: Workspace,
  canvas: ChallengeCanvas,
): WorkspaceProgramSnapshot {
  return {
    xml: serializeWorkspaceToXml(workspace),
    program: workspaceToBackendProgram(workspace, { canvas }),
  }
}

export async function submitWorkspaceProgram({
  workspace,
  canvas,
  challengeId,
  createSubmission,
}: SubmitWorkspaceProgramOptions) {
  const snapshot = buildWorkspaceProgramSnapshot(workspace, canvas)
  const response = await createSubmission(challengeId, snapshot.program)

  return {
    ...snapshot,
    response,
  }
}

export function queueItemsForChallenge(
  queue: MyQueueResponse | undefined,
  challengeId: string | undefined,
): CurrentChallengeQueueItem[] {
  if (!queue || !challengeId) return []

  const queued = queue.queued_submissions.map(({ submission, position }) => ({
    submission,
    position,
    status: submission.status,
  }))
  const running = queue.running_submission
    ? [
        {
          submission: queue.running_submission.submission,
          position: queue.running_submission.position,
          status: queue.running_submission.submission.status,
        },
      ]
    : []

  return [...running, ...queued].filter((item) => item.submission.challenge_id === challengeId)
}

export function statusTextForSubmission(submission: Submission): string {
  if (submission.status === "queued" || submission.status === "running") return "等待評測中"
  if (submission.status === "completed") return submission.passed ? "已解出" : "尚未解出"
  if (submission.status === "failed") return "評測失敗"
  if (submission.status === "cancelled") return "已取消"
  return submission.status
}

export function solvedText(solved: boolean): "已解出" | "尚未解出" {
  return solved ? "已解出" : "尚未解出"
}
