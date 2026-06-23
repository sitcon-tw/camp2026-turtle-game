import { useMemo } from "react"

import { cn } from "@/lib/utils"
import { normalizeExecutionTrace, normalizeTurtleProgram, previewStats, traceFromProgram } from "@/lib/turtle"
import type { ExecutionTrace, TraceStep, TurtleChallengeLike, TurtleProgram } from "@/lib/turtle"

import { ChallengeRenderer } from "./ChallengeRenderer"

export type TurtlePreviewPanelProps = {
  challenge?: TurtleChallengeLike | null
  program?: TurtleProgram | unknown
  trace?: ExecutionTrace | TraceStep[] | unknown
  resultImageUrl?: string | null
  title?: string
  sourceLabel?: string
  compact?: boolean
  animated?: boolean
  animationKey?: string | number
  currentStepIndex?: number
  showTarget?: boolean
  showTurtle?: boolean
  className?: string
  viewportClassName?: string
  rendererClassName?: string
  canvasClassName?: string
  footerStart?: string
  footerEnd?: string
}

export function TurtlePreviewPanel({
  challenge,
  program,
  trace,
  resultImageUrl,
  title = "Preview",
  sourceLabel,
  compact = false,
  animated = false,
  animationKey,
  currentStepIndex,
  showTarget = false,
  showTurtle = false,
  className,
  viewportClassName,
  rendererClassName,
  canvasClassName,
  footerStart,
  footerEnd,
}: TurtlePreviewPanelProps) {
  const preview = useMemo(() => {
    const normalizedProgram = normalizeTurtleProgram(program)
    const normalizedTrace = normalizeExecutionTrace(trace, normalizedProgram) ?? (normalizedProgram ? traceFromProgram(normalizedProgram) : null)
    return previewStats(normalizedTrace, normalizedProgram)
  }, [program, trace])
  const hasProgram = program !== null && program !== undefined
  const hasTrace = trace !== null && trace !== undefined
  const hasPreview = preview.lines.length > 0 || preview.stepCount !== null || Boolean(resultImageUrl)
  const resolvedSourceLabel = sourceLabel ?? (hasTrace ? "trace" : hasProgram ? "block program" : "no program")

  return (
    <div
      className={cn(
        "overflow-hidden rounded-md border bg-muted/20 text-xs",
        compact ? "w-56" : "w-full",
        className,
      )}
    >
      <div className="flex items-center justify-between gap-3 border-b bg-background/70 px-2 py-1">
        <span className="font-medium">{title}</span>
        <span className="truncate text-muted-foreground">{resolvedSourceLabel}</span>
      </div>

      <div className={cn("bg-background", compact ? "h-28" : "h-44", viewportClassName)}>
        {hasPreview ? (
          <ChallengeRenderer
            challenge={challenge}
            trace={trace}
            program={program}
            resultImageUrl={resultImageUrl}
            compact={compact}
            animated={animated}
            animationKey={animationKey}
            currentStepIndex={currentStepIndex}
            showTarget={showTarget}
            showTurtle={showTurtle}
            className={rendererClassName}
            canvasClassName={canvasClassName}
          />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-1 px-3 text-center text-muted-foreground">
            <span>{fallbackMessage(hasTrace, hasProgram)}</span>
            {preview.blockCount !== null ? <span>{preview.blockCount} blocks</span> : null}
          </div>
        )}
      </div>

      <div className="flex justify-between gap-3 border-t bg-background/70 px-2 py-1 text-muted-foreground">
        <span>{footerStart ?? (preview.stepCount === null ? "steps -" : `${preview.stepCount} steps`)}</span>
        <span>{footerEnd ?? `${preview.lines.length} lines`}</span>
      </div>
    </div>
  )
}

function fallbackMessage(hasTrace: boolean, hasProgram: boolean) {
  if (hasTrace) return "Trace has no drawable lines"
  if (hasProgram) return "Program preview unavailable"
  return "No trace or program"
}
