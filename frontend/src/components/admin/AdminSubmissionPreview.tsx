import { useMemo } from "react"

import { ChallengeRenderer } from "@/components/turtle"
import type { Submission } from "@/lib/admin/types"
import { normalizeExecutionTrace, normalizeTurtleProgram, previewStats, traceFromProgram } from "@/lib/turtle"
import { cn } from "@/lib/utils"

type AdminSubmissionPreviewProps = {
  submission: Submission
  compact?: boolean
  className?: string
}

export function AdminSubmissionPreview({ submission, compact = false, className }: AdminSubmissionPreviewProps) {
  const hasTrace = submission.trace !== null && submission.trace !== undefined
  const hasBlockProgram = submission.block_program !== null && submission.block_program !== undefined
  const preview = useMemo(() => {
    const program = normalizeTurtleProgram(submission.block_program)
    const trace = normalizeExecutionTrace(submission.trace, program) ?? (program ? traceFromProgram(program) : null)
    return previewStats(trace, program)
  }, [submission.trace, submission.block_program])
  const sourceLabel = hasTrace ? "trace" : hasBlockProgram ? "block program" : "no program"

  return (
    <div
      className={cn(
        "overflow-hidden rounded-md border bg-muted/20 text-xs",
        compact ? "w-56" : "w-full",
        className,
      )}
    >
      <div className="flex items-center justify-between gap-3 border-b bg-background/70 px-2 py-1">
        <span className="font-medium">Preview</span>
        <span className="truncate text-muted-foreground">{sourceLabel}</span>
      </div>

      <div className={cn("bg-background", compact ? "h-28" : "h-44")}>
        {preview.lines.length > 0 || submission.result_image_url ? (
          <ChallengeRenderer
            trace={submission.trace}
            program={submission.block_program}
            resultImageUrl={submission.result_image_url}
            compact={compact}
            showTarget={false}
            showTurtle={false}
          />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-1 px-3 text-center text-muted-foreground">
            <span>{fallbackMessage(hasTrace, hasBlockProgram)}</span>
            {preview.blockCount !== null ? <span>{preview.blockCount} blocks</span> : null}
          </div>
        )}
      </div>

      <div className="flex justify-between gap-3 border-t bg-background/70 px-2 py-1 text-muted-foreground">
        <span>{preview.stepCount === null ? "steps -" : `${preview.stepCount} steps`}</span>
        <span>{preview.lines.length} lines</span>
      </div>
    </div>
  )
}

export default AdminSubmissionPreview

function fallbackMessage(hasTrace: boolean, hasBlockProgram: boolean) {
  if (hasTrace) return "Trace has no drawable lines"
  if (hasBlockProgram) return "Program preview unavailable"
  return "No trace or program"
}
