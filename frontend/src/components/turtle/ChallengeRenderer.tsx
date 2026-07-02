import { useMemo } from "react"

import { cn } from "@/lib/utils"
import {
  challengeTargetImageSrc,
  inferCanvas,
  normalizeExecutionTrace,
  normalizeTurtleProgram,
  previewStats,
  traceFromProgram,
} from "@/lib/turtle"
import type { ExecutionTrace, TraceStep, TurtleChallengeLike, TurtleProgram } from "@/lib/turtle"

import { TurtleCanvas } from "./TurtleCanvas"

export type ChallengeRendererProps = {
  challenge?: TurtleChallengeLike | null
  program?: TurtleProgram | unknown
  trace?: ExecutionTrace | TraceStep[] | unknown
  resultImageUrl?: string | null
  targetImageSrc?: string
  animated?: boolean
  animationKey?: string | number
  compact?: boolean
  showTarget?: boolean
  showTurtle?: boolean
  className?: string
  canvasClassName?: string
  targetImageOpacity?: number
  currentStepIndex?: number
}

export function ChallengeRenderer({
  challenge,
  program,
  trace,
  resultImageUrl,
  targetImageSrc,
  animated = false,
  animationKey,
  compact = false,
  showTarget = true,
  showTurtle = true,
  className,
  canvasClassName,
  targetImageOpacity = 0.28,
  currentStepIndex,
}: ChallengeRendererProps) {
  const challengeCanvas = useMemo(
    () =>
      challenge?.canvas
        ? {
            width: challenge.canvas.width ?? undefined,
            height: challenge.canvas.height ?? undefined,
            background_color: challenge.canvas.background_color ?? undefined,
          }
        : undefined,
    [challenge],
  )
  const normalizedProgram = useMemo(
    () => normalizeTurtleProgram(program, challengeCanvas),
    [challengeCanvas, program],
  )
  const normalizedTrace = useMemo(() => {
    const existingTrace = normalizeExecutionTrace(trace, normalizedProgram)
    if (existingTrace) return existingTrace
    return normalizedProgram ? traceFromProgram(normalizedProgram) : null
  }, [normalizedProgram, trace])
  const stats = useMemo(() => previewStats(normalizedTrace, normalizedProgram), [normalizedProgram, normalizedTrace])
  const canvas = useMemo(() => inferCanvas(normalizedTrace, normalizedProgram), [normalizedProgram, normalizedTrace])
  const resolvedTargetImageSrc = showTarget ? targetImageSrc ?? challengeTargetImageSrc(challenge) : undefined
  const hasPlayback = (normalizedTrace?.steps.length ?? 0) > 0

  if (!hasPlayback && resultImageUrl) {
    return (
      <div className={cn("flex h-full w-full items-center justify-center bg-background", className)}>
        <img
          src={resultImageUrl}
          alt="Submission result"
          className={cn("max-h-full max-w-full object-contain", canvasClassName)}
        />
      </div>
    )
  }

  if (!hasPlayback && resolvedTargetImageSrc) {
    return (
      <div className={cn("flex h-full w-full items-center justify-center bg-background", className)}>
        <img
          src={resolvedTargetImageSrc}
          alt="Challenge target"
          className={cn("max-h-full max-w-full object-contain", canvasClassName)}
        />
      </div>
    )
  }

  return (
    <div className={cn("relative h-full w-full overflow-hidden bg-background", className)}>
      {hasPlayback ? (
        <TurtleCanvas
          program={normalizedProgram}
          trace={normalizedTrace}
          width={compact ? undefined : canvas.width}
          height={compact ? undefined : canvas.height}
          animated={animated}
          animationKey={animationKey}
          currentStepIndex={currentStepIndex}
          showTurtle={showTurtle}
          targetImageSrc={resolvedTargetImageSrc}
          targetImageOpacity={targetImageOpacity}
          backgroundColor={canvas.background_color}
          className={cn("h-full w-full", canvasClassName)}
          style={{ width: "100%", height: "100%" }}
        />
      ) : (
        <div className="flex h-full flex-col items-center justify-center gap-1 px-3 text-center text-xs text-muted-foreground">
          <span>{normalizedProgram ? "Program has no drawable preview" : "No trace or program"}</span>
          {stats.blockCount !== null ? <span>{stats.blockCount} blocks</span> : null}
        </div>
      )}
    </div>
  )
}
