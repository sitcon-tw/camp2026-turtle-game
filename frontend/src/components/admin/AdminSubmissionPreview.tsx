import { useMemo } from "react"

import type { Submission } from "@/lib/admin/types"
import { interpretProgram, isTurtleProgram } from "@/lib/turtle"
import type { TraceStep } from "@/lib/turtle"
import { TurtleCanvas } from "@/components/turtle/TurtleCanvas"
import { cn } from "@/lib/utils"

type AdminSubmissionPreviewProps = {
  submission: Submission
  compact?: boolean
  className?: string
}

type TraceLine = {
  fromX: number
  fromY: number
  toX: number
  toY: number
  color: string
  strokeWidth: number
}

type PreviewData = {
  lines: TraceLine[]
  stepCount: number | null
  blockCount: number | null
  width: number
  height: number
}

export function AdminSubmissionPreview({ submission, compact = false, className }: AdminSubmissionPreviewProps) {
  const hasTrace = submission.trace !== null && submission.trace !== undefined
  const hasBlockProgram = submission.block_program !== null && submission.block_program !== undefined
  const program = isTurtleProgram(submission.block_program) ? submission.block_program : null
  const submittedTrace = traceFromUnknown(submission.trace)
  const interpretedTrace = useMemo(() => (submittedTrace ?? (program ? interpretProgram(program) : null)), [program, submittedTrace])
  const trace = submittedTrace ?? interpretedTrace
  const preview = useMemo(() => buildPreviewData(trace, submission.block_program), [trace, submission.block_program])
  const sourceLabel = hasTrace ? "trace" : interpretedTrace ? "interpreted program" : hasBlockProgram ? "block program" : "no program"

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
        {program || trace ? (
          <TurtleCanvas
            program={program ?? undefined}
            trace={trace ?? undefined}
            width={preview.width}
            height={preview.height}
            showTurtle={!compact}
            className="h-full w-full"
          />
        ) : preview.lines.length > 0 ? (
          <FallbackTraceSvg preview={preview} />
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

function FallbackTraceSvg({ preview }: { preview: PreviewData }) {
  return (
    <svg
      className="h-full w-full"
      viewBox={`0 0 ${preview.width} ${preview.height}`}
      role="img"
      aria-label="Submission trace preview"
    >
      <rect width={preview.width} height={preview.height} fill="white" />
      {preview.lines.map((line, index) => (
        <line
          key={`${index}-${line.fromX}-${line.fromY}-${line.toX}-${line.toY}`}
          x1={line.fromX}
          y1={line.fromY}
          x2={line.toX}
          y2={line.toY}
          stroke={line.color}
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={line.strokeWidth}
        />
      ))}
    </svg>
  )
}

function fallbackMessage(hasTrace: boolean, hasBlockProgram: boolean) {
  if (hasTrace) return "Trace has no drawable lines"
  if (hasBlockProgram) return "Program preview unavailable"
  return "No trace or program"
}

function buildPreviewData(trace: unknown, blockProgram: unknown): PreviewData {
  const steps = Array.isArray(trace) ? trace : arrayFromRecord(trace, "steps")
  const lines = steps.flatMap((step) => {
    const line = recordFromRecord(step, "draw_line") ?? recordFromRecord(step, "drawLine")
    return line ? traceLineFromRecord(line) : []
  })
  const canvas = canvasSize(trace, blockProgram, lines)
  const blocks = arrayFromRecord(blockProgram, "blocks")

  return {
    lines,
    stepCount: steps.length > 0 ? steps.length : null,
    blockCount: blocks.length > 0 ? blocks.length : null,
    width: canvas.width,
    height: canvas.height,
  }
}

function traceFromUnknown(value: unknown): TraceStep[] | null {
  if (!Array.isArray(value)) return null
  return value.every(isTraceStep) ? value : null
}

function isTraceStep(value: unknown): value is TraceStep {
  const record = toRecord(value)
  return (
    record !== null &&
    typeof record.step_index === "number" &&
    typeof record.block_id === "string" &&
    typeof record.block_type === "string" &&
    toRecord(record.before) !== null &&
    toRecord(record.after) !== null
  )
}

function traceLineFromRecord(line: Record<string, unknown>): TraceLine[] {
  const fromX = numberFromRecord(line, "from_x") ?? numberFromRecord(line, "fromX")
  const fromY = numberFromRecord(line, "from_y") ?? numberFromRecord(line, "fromY")
  const toX = numberFromRecord(line, "to_x") ?? numberFromRecord(line, "toX")
  const toY = numberFromRecord(line, "to_y") ?? numberFromRecord(line, "toY")

  if (fromX === null || fromY === null || toX === null || toY === null) return []

  return [
    {
      fromX,
      fromY,
      toX,
      toY,
      color: colorValue(line.color),
      strokeWidth: numberFromRecord(line, "stroke_width") ?? numberFromRecord(line, "strokeWidth") ?? 1,
    },
  ]
}

function canvasSize(trace: unknown, blockProgram: unknown, lines: TraceLine[]) {
  const program = toRecord(blockProgram)
  const traceRecord = toRecord(trace)
  const canvas = recordFromRecord(program, "canvas") ?? recordFromRecord(traceRecord, "canvas")
  const width =
    numberFromRecord(canvas, "width") ??
    numberFromRecord(program, "canvas_width") ??
    numberFromRecord(program, "canvasWidth") ??
    inferredExtent(lines, "x") ??
    600
  const height =
    numberFromRecord(canvas, "height") ??
    numberFromRecord(program, "canvas_height") ??
    numberFromRecord(program, "canvasHeight") ??
    inferredExtent(lines, "y") ??
    400

  return {
    width: Math.max(1, width),
    height: Math.max(1, height),
  }
}

function inferredExtent(lines: TraceLine[], axis: "x" | "y") {
  if (lines.length === 0) return null
  const values = lines.flatMap((line) => (axis === "x" ? [line.fromX, line.toX] : [line.fromY, line.toY]))
  return Math.max(...values, 1)
}

function arrayFromRecord(value: unknown, key: string) {
  const record = toRecord(value)
  const child = record?.[key]
  return Array.isArray(child) ? child : []
}

function recordFromRecord(value: unknown, key: string) {
  const record = toRecord(value)
  return toRecord(record?.[key])
}

function numberFromRecord(value: unknown, key: string) {
  const record = toRecord(value)
  const child = record?.[key]
  return typeof child === "number" && Number.isFinite(child) ? child : null
}

function toRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

function colorValue(value: unknown) {
  if (typeof value === "string") return value

  const color = toRecord(value)
  const r = numberFromRecord(color, "r") ?? numberFromRecord(color, "red") ?? 0
  const g = numberFromRecord(color, "g") ?? numberFromRecord(color, "green") ?? 0
  const b = numberFromRecord(color, "b") ?? numberFromRecord(color, "blue") ?? 0
  const a = numberFromRecord(color, "a") ?? numberFromRecord(color, "alpha") ?? 255

  return `rgba(${clampColor(r)}, ${clampColor(g)}, ${clampColor(b)}, ${clampAlpha(a)})`
}

function clampColor(value: number) {
  return Math.max(0, Math.min(255, Math.round(value)))
}

function clampAlpha(value: number) {
  return value > 1 ? Math.max(0, Math.min(1, value / 255)) : Math.max(0, Math.min(1, value))
}
