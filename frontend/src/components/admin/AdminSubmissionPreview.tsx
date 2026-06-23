import { TurtlePreviewPanel } from "@/components/turtle"
import type { Submission } from "@/lib/admin/types"

type AdminSubmissionPreviewProps = {
  submission: Submission
  compact?: boolean
  className?: string
}

export function AdminSubmissionPreview({ submission, compact = false, className }: AdminSubmissionPreviewProps) {
  const hasTrace = submission.trace !== null && submission.trace !== undefined
  const hasBlockProgram = submission.block_program !== null && submission.block_program !== undefined
  const sourceLabel = hasTrace ? "trace" : hasBlockProgram ? "block program" : "no program"

  return (
    <TurtlePreviewPanel
      trace={submission.trace}
      program={submission.block_program}
      resultImageUrl={submission.result_image_url}
      sourceLabel={sourceLabel}
      compact={compact}
      showTarget={false}
      showTurtle={false}
      className={className}
    />
  )
}

export default AdminSubmissionPreview
