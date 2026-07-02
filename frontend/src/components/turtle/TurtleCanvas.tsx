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
    stepStartedAt: number
    now: number
  } | null>(null)
  const [controlledStepProgress, setControlledStepProgress] = useState(1)
  const [viewportSize, setViewportSize] = useState<{ width: number; height: number } | null>(null)
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
  const bitmapWidth = Math.max(1, Math.round((viewportSize?.width ?? displayWidth) * pixelRatio))
  const bitmapHeight = Math.max(1, Math.round((viewportSize?.height ?? displayHeight) * pixelRatio))
  const playbackId = `${animationKey ?? "default"}:${normalizedTrace?.steps.length ?? 0}`
  const autoStepIndex = animated && playbackState?.id === playbackId ? playbackState.stepIndex : -1
  const renderedStepIndex = currentStepIndex ?? (animated ? autoStepIndex : undefined)
  const autoStepProgress =
    animated && playbackState?.id === playbackId
      ? playbackProgress(playbackState.now, playbackState.stepStartedAt)
      : 1
  const renderedStepProgress = currentStepIndex !== undefined ? (animated ? controlledStepProgress : 1) : autoStepProgress
  const targetImage = targetImageState && targetImageState.src === targetImageSrc ? targetImageState.image : null

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || typeof ResizeObserver === "undefined") return

    let animationFrame = 0
    const publishSize = (nextWidth: number, nextHeight: number) => {
      if (nextWidth <= 0 || nextHeight <= 0) return

      setViewportSize((current) =>
        current && Math.abs(current.width - nextWidth) < 0.5 && Math.abs(current.height - nextHeight) < 0.5
          ? current
          : { width: nextWidth, height: nextHeight },
      )
    }
    const measure = () => {
      const rect = canvas.getBoundingClientRect()
      publishSize(rect.width, rect.height)
    }
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0]
      const borderBox = Array.isArray(entry.borderBoxSize) ? entry.borderBoxSize[0] : entry.borderBoxSize
      publishSize(borderBox?.inlineSize ?? entry.contentRect.width, borderBox?.blockSize ?? entry.contentRect.height)
    })

    observer.observe(canvas)
    animationFrame = window.requestAnimationFrame(measure)

    return () => {
      observer.disconnect()
      window.cancelAnimationFrame(animationFrame)
    }
  }, [])

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

    if (normalizedTrace.steps.length === 0) {
      onPlaybackEnd?.()
      return
    }

    let cancelled = false
    let animationFrame = 0
    let stepIndex = 0
    let stepStartedAt = performance.now()
    let hasEnded = false

    const publishFrame = (now: number) => {
      setPlaybackState({ id: playbackId, stepIndex, stepStartedAt, now })
    }

    const tick = (now: number) => {
      if (cancelled || hasEnded) return

      while (now - stepStartedAt >= playbackDelayForStep(normalizedTrace.steps[stepIndex])) {
        stepIndex += 1
        stepStartedAt = now

        if (stepIndex >= normalizedTrace.steps.length) {
          if (loop) {
            stepIndex = 0
            break
          }

          hasEnded = true
          setPlaybackState({
            id: playbackId,
            stepIndex: normalizedTrace.steps.length - 1,
            stepStartedAt: now - playbackDelayForStep(normalizedTrace.steps.at(-1)),
            now,
          })
          onPlaybackEnd?.()
          return
        }
      }

      publishFrame(now)
      animationFrame = window.requestAnimationFrame(tick)
    }

    publishFrame(stepStartedAt)
    animationFrame = window.requestAnimationFrame(tick)

    return () => {
      cancelled = true
      window.cancelAnimationFrame(animationFrame)
    }
  }, [animated, currentStepIndex, loop, normalizedTrace, onPlaybackEnd, playbackId])

  useEffect(() => {
    if (!animated || currentStepIndex === undefined) return

    let cancelled = false
    let animationFrame = 0
    const startedAt = performance.now()

    const tick = (now: number) => {
      if (cancelled) return
      const progress = playbackProgress(now, startedAt)
      setControlledStepProgress(progress)
      if (progress < 1) animationFrame = window.requestAnimationFrame(tick)
    }

    animationFrame = window.requestAnimationFrame(tick)

    return () => {
      cancelled = true
      window.cancelAnimationFrame(animationFrame)
    }
  }, [animated, currentStepIndex])

  useEffect(() => {
    const canvas = canvasRef.current
    const ctx = canvas?.getContext("2d")
    if (!ctx) return

    drawTraceToCanvas(ctx, normalizedTrace?.steps ?? [], {
      canvas: canvasSpec,
      stepIndex: renderedStepIndex,
      stepProgress: renderedStepProgress,
      scaleToFit,
      backgroundColor: backgroundColor ?? canvasSpec.background_color,
      targetImage,
      targetImageOpacity,
      showTurtle,
      turtleState,
    })
  }, [
    backgroundColor,
    bitmapHeight,
    bitmapWidth,
    canvasSpec,
    normalizedTrace,
    renderedStepIndex,
    renderedStepProgress,
    scaleToFit,
    showTurtle,
    targetImage,
    targetImageOpacity,
    turtleState,
  ])

  return (
    <canvas
      ref={canvasRef}
      data-slot="turtle-canvas"
      className={className}
      width={bitmapWidth}
      height={bitmapHeight}
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

function playbackProgress(now: number, stepStartedAt: number) {
  return Math.max(0, Math.min(1, (now - stepStartedAt) / playbackDelayForStep()))
}
