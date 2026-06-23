import { useEffect, useMemo, useRef, useState } from "react"
import type { CSSProperties } from "react"

import {
  drawTraceToCanvas,
  inferCanvas,
  normalizeExecutionTrace,
  normalizeTurtleProgram,
  playbackDelayForStep,
  traceFromProgram,
} from "@/lib/turtle"
import type { ExecutionTrace, TraceStep, TurtleCanvasSpec, TurtleProgram, TurtleState } from "@/lib/turtle"

export type TurtleCanvasProps = {
  program?: TurtleProgram | unknown
  trace?: ExecutionTrace | TraceStep[] | unknown
  width?: number
  height?: number
  currentStepIndex?: number
  animated?: boolean
  animationKey?: string | number
  playbackMsPerStep?: number
  loop?: boolean
  scaleToFit?: boolean
  showTurtle?: boolean
  turtleState?: TurtleState
  targetImageSrc?: string
  targetImageOpacity?: number
  backgroundColor?: string
  className?: string
  style?: CSSProperties
  onPlaybackEnd?: () => void
}

export function TurtleCanvas({
  program,
  trace,
  width,
  height,
  currentStepIndex,
  animated = false,
  animationKey,
  playbackMsPerStep = 180,
  loop = false,
  scaleToFit = true,
  showTurtle = true,
  turtleState,
  targetImageSrc,
  targetImageOpacity,
  backgroundColor,
  className,
  style,
  onPlaybackEnd,
}: TurtleCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const [targetImageState, setTargetImageState] = useState<{
    src: string
    image: HTMLImageElement
  } | null>(null)
  const [playbackState, setPlaybackState] = useState<{
    id: string
    stepIndex: number
  } | null>(null)
  const normalizedProgram = useMemo(() => normalizeTurtleProgram(program), [program])
  const normalizedTrace = useMemo(() => {
    const existingTrace = normalizeExecutionTrace(trace, normalizedProgram)
    if (existingTrace) return existingTrace
    return normalizedProgram ? traceFromProgram(normalizedProgram) : null
  }, [normalizedProgram, trace])
  const canvasSpec = useMemo<TurtleCanvasSpec>(() => {
    const inferred = inferCanvas(normalizedTrace, normalizedProgram)
    return {
      ...inferred,
      width: width ?? inferred.width,
      height: height ?? inferred.height,
    }
  }, [height, normalizedProgram, normalizedTrace, width])
  const displayWidth = width ?? canvasSpec.width
  const displayHeight = height ?? canvasSpec.height
  const pixelRatio = typeof window === "undefined" ? 1 : window.devicePixelRatio || 1
  const playbackId = `${animationKey ?? "default"}:${normalizedTrace?.steps.length ?? 0}`
  const autoStepIndex = animated && playbackState?.id === playbackId ? playbackState.stepIndex : -1
  const renderedStepIndex = currentStepIndex ?? (animated ? autoStepIndex : undefined)
  const targetImage = targetImageState && targetImageState.src === targetImageSrc ? targetImageState.image : null

  useEffect(() => {
    if (!targetImageSrc) return

    let active = true
    const image = new Image()
    image.crossOrigin = "anonymous"
    image.onload = () => {
      if (active) setTargetImageState({ src: targetImageSrc, image })
    }
    image.onerror = () => {
      if (active) setTargetImageState(null)
    }
    image.src = targetImageSrc

    return () => {
      active = false
    }
  }, [targetImageSrc])

  useEffect(() => {
    if (!animated || !normalizedTrace || currentStepIndex !== undefined) return

    const nextIndex = (autoStepIndex ?? -1) + 1
    if (nextIndex >= normalizedTrace.steps.length) {
      if (loop && normalizedTrace.steps.length > 0) {
        const timer = window.setTimeout(() => setPlaybackState({ id: playbackId, stepIndex: -1 }), playbackMsPerStep)
        return () => window.clearTimeout(timer)
      }
      onPlaybackEnd?.()
      return
    }

    const timer = window.setTimeout(
      () => setPlaybackState({ id: playbackId, stepIndex: nextIndex }),
      playbackDelayForStep(normalizedTrace.steps[nextIndex], playbackMsPerStep),
    )
    return () => window.clearTimeout(timer)
  }, [animated, autoStepIndex, currentStepIndex, loop, normalizedTrace, onPlaybackEnd, playbackId, playbackMsPerStep])

  useEffect(() => {
    const canvas = canvasRef.current
    const ctx = canvas?.getContext("2d")
    if (!ctx) return

    drawTraceToCanvas(ctx, normalizedTrace?.steps ?? [], {
      canvas: canvasSpec,
      stepIndex: renderedStepIndex,
      scaleToFit,
      backgroundColor: backgroundColor ?? canvasSpec.background_color,
      targetImage,
      targetImageOpacity,
      showTurtle,
      turtleState,
    })
  }, [
    backgroundColor,
    canvasSpec,
    normalizedTrace,
    renderedStepIndex,
    scaleToFit,
    showTurtle,
    targetImage,
    targetImageOpacity,
    turtleState,
  ])

  return (
    <canvas
      ref={canvasRef}
      className={className}
      width={Math.max(1, Math.round(displayWidth * pixelRatio))}
      height={Math.max(1, Math.round(displayHeight * pixelRatio))}
      style={{
        display: "block",
        maxWidth: "100%",
        width: displayWidth,
        height: displayHeight,
        ...style,
      }}
    />
  )
}
