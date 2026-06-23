import type {
  CanonicalBlockArgs,
  DrawLine,
  ExecutionTrace,
  TraceStep,
  TurtleBlock,
  TurtleBlockType,
  TurtleCanvasSpec,
  TurtleChallengeLike,
  TurtleProgram,
  TurtleState,
} from "./types"

export type DrawTraceOptions = {
  canvas?: TurtleCanvasSpec
  stepIndex?: number
  scaleToFit?: boolean
  backgroundColor?: string
  targetImage?: CanvasImageSource | null
  targetImageOpacity?: number
  showTurtle?: boolean
  turtleState?: TurtleState
}

type ProgramRecord = Record<string, unknown>

export const DEFAULT_CANVAS: TurtleCanvasSpec = {
  width: 640,
  height: 480,
  background_color: "#ffffff",
}

const DEFAULT_STROKE_COLOR = "#000000"
const DEFAULT_STROKE_WIDTH = 1
const DEFAULT_STEP_DURATION_MS = 180

export function createDefaultProgram(canvas: Partial<TurtleCanvasSpec> = {}): TurtleProgram {
  const normalizedCanvas = normalizeCanvas(canvas)

  return {
    version: 1,
    canvas: normalizedCanvas,
    start: {
      x: normalizedCanvas.width / 2,
      y: normalizedCanvas.height / 2,
      heading: 0,
      pen_down: true,
      stroke_color: DEFAULT_STROKE_COLOR,
      stroke_width: DEFAULT_STROKE_WIDTH,
    },
    blocks: [],
  }
}

export function normalizeTurtleProgram(value: unknown, fallbackCanvas?: Partial<TurtleCanvasSpec>): TurtleProgram | null {
  const record = toRecord(value)
  if (!record) return null

  const canvas = normalizeCanvas({
    ...fallbackCanvas,
    ...readCanvas(record),
  })
  const start = normalizeTurtleState(record.start, createDefaultProgram(canvas).start)
  const blocksValue = Array.isArray(record.blocks) ? record.blocks : []
  const blocks = normalizeBlocks(blocksValue)

  return {
    version: 1,
    canvas,
    start,
    blocks,
  }
}

export function normalizeExecutionTrace(value: unknown, fallbackProgram?: unknown): ExecutionTrace | null {
  const traceRecord = toRecord(value)
  const rawSteps = Array.isArray(value) ? value : arrayFromRecord(traceRecord, "steps")
  if (rawSteps.length === 0) return null

  const program = normalizeTurtleProgram(fallbackProgram)
  const fallbackState = program?.start ?? createDefaultProgram(readCanvas(traceRecord)).start
  const steps = rawSteps.flatMap((step, index) => normalizeTraceStep(step, index, fallbackState))
  const finalState =
    normalizeTurtleState(traceRecord?.final_state, steps.at(-1)?.after ?? fallbackState) ??
    steps.at(-1)?.after ??
    fallbackState

  return { final_state: finalState, steps }
}

export function traceFromProgram(program: TurtleProgram): ExecutionTrace {
  return interpretProgram(program)
}

export function interpretProgram(program: TurtleProgram): ExecutionTrace {
  const trace: TraceStep[] = []
  let state = cloneState(program.start)

  const addStep = (
    block: TurtleBlock,
    before: TurtleState,
    after: TurtleState,
    drawLine: DrawLine | null,
    durationMs = 0,
  ) => {
    trace.push({
      step_index: trace.length,
      block_id: block.id,
      block_type: block.type,
      before,
      after,
      draw_line: drawLine,
      duration_ms: Math.max(0, durationMs),
    })
  }

  const runBlocks = (blocks: TurtleBlock[]) => {
    for (const block of blocks) {
      if (block.type === "repeat") {
        const times = Math.max(0, Math.floor(finiteNumber(block.args.times, 0)))
        for (let index = 0; index < times; index += 1) runBlocks(block.children)
        continue
      }

      const before = cloneState(state)
      const after = cloneState(state)
      let drawLine: DrawLine | null = null
      let durationMs = 0

      switch (block.type) {
        case "forward":
          drawLine = moveTurtle(after, block.args.distance)
          break
        case "backward":
          drawLine = moveTurtle(after, -block.args.distance)
          break
        case "turn_left":
          after.heading = normalizeHeading(after.heading + block.args.degrees)
          break
        case "turn_right":
          after.heading = normalizeHeading(after.heading - block.args.degrees)
          break
        case "pen_up":
          after.pen_down = false
          break
        case "pen_down":
          after.pen_down = true
          break
        case "set_color":
          after.stroke_color = block.args.color
          break
        case "set_stroke_width":
          after.stroke_width = block.args.width
          break
        case "goto":
          drawLine = gotoTurtle(after, block.args.x, block.args.y)
          break
        case "set_heading":
          after.heading = normalizeHeading(block.args.degrees)
          break
        case "clear":
          break
        case "wait":
          durationMs = block.args.duration_ms
          break
      }

      addStep(block, before, after, drawLine, durationMs)
      state = cloneState(after)
    }
  }

  runBlocks(program.blocks)

  return {
    final_state: state,
    steps: trace,
  }
}

export function drawTraceToCanvas(ctx: CanvasRenderingContext2D, trace: TraceStep[], options: DrawTraceOptions = {}): void {
  const outputWidth = ctx.canvas.width
  const outputHeight = ctx.canvas.height
  const canvas = normalizeCanvas(options.canvas ?? { width: outputWidth, height: outputHeight })
  const scaleToFit = options.scaleToFit ?? true
  const scale = scaleToFit ? Math.min(outputWidth / canvas.width, outputHeight / canvas.height) : 1
  const offsetX = scaleToFit ? (outputWidth - canvas.width * scale) / 2 : 0
  const offsetY = scaleToFit ? (outputHeight - canvas.height * scale) / 2 : 0
  const visibleTrace = getVisibleTrace(trace, options.stepIndex)
  const finalState = options.turtleState ?? visibleTrace.at(-1)?.after ?? trace[0]?.before

  ctx.save()
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.clearRect(0, 0, outputWidth, outputHeight)
  ctx.translate(offsetX, offsetY)
  ctx.scale(scale, scale)

  paintBackground(ctx, canvas, options)

  for (const step of visibleTrace) {
    if (step.block_type === "clear") {
      ctx.clearRect(0, 0, canvas.width, canvas.height)
      paintBackground(ctx, canvas, options)
      continue
    }

    if (step.draw_line) drawLine(ctx, step.draw_line)
  }

  if (options.showTurtle && finalState) drawTurtle(ctx, finalState)

  ctx.restore()
}

export function previewStats(trace: ExecutionTrace | null, program: TurtleProgram | null) {
  const steps = trace?.steps ?? []
  const lines = visibleLinesForStep(steps)
  const canvas = inferCanvas(trace, program, lines)

  return {
    lines,
    stepCount: steps.length > 0 ? steps.length : null,
    blockCount: program ? countBlocks(program.blocks) : null,
    width: canvas.width,
    height: canvas.height,
  }
}

export function inferCanvas(
  trace: ExecutionTrace | null,
  program: TurtleProgram | null,
  lines: DrawLine[] = trace ? visibleLinesForStep(trace.steps) : [],
): TurtleCanvasSpec {
  if (program?.canvas) return normalizeCanvas(program.canvas)

  const xs = lines.flatMap((line) => [line.from_x, line.to_x])
  const ys = lines.flatMap((line) => [line.from_y, line.to_y])
  const width = xs.length > 0 ? Math.max(...xs, DEFAULT_CANVAS.width) : DEFAULT_CANVAS.width
  const height = ys.length > 0 ? Math.max(...ys, DEFAULT_CANVAS.height) : DEFAULT_CANVAS.height

  return normalizeCanvas({ width, height })
}

export function visibleLinesForStep(trace: TraceStep[], stepIndex?: number): DrawLine[] {
  const lines: DrawLine[] = []
  for (const step of getVisibleTrace(trace, stepIndex)) {
    if (step.block_type === "clear") {
      lines.length = 0
      continue
    }
    if (step.draw_line) lines.push(step.draw_line)
  }
  return lines
}

export function playbackDelayForStep(step: TraceStep | undefined, fallbackMs = DEFAULT_STEP_DURATION_MS) {
  return Math.max(0, step?.duration_ms && step.duration_ms > 0 ? step.duration_ms : fallbackMs)
}

export function normalizeHeading(degrees: number): number {
  const normalized = finiteNumber(degrees, 0) % 360
  return normalized < 0 ? normalized + 360 : normalized
}

export function challengeTargetImageSrc(challenge?: TurtleChallengeLike | null): string | undefined {
  if (!challenge) return undefined
  if (challenge.target_image_url) return challenge.target_image_url
  if (challenge.target_image_asset_id) return `/api/v1/assets/challenges/${challenge.target_image_asset_id}`
  return undefined
}

export function cloneTurtleProgram(program: TurtleProgram): TurtleProgram {
  return JSON.parse(JSON.stringify(program)) as TurtleProgram
}

export function serializeTurtleProgram(program: TurtleProgram, space = 2): string {
  return JSON.stringify(program, null, space)
}

export function parseTurtleProgramJson(json: string): TurtleProgram {
  const program = normalizeTurtleProgram(JSON.parse(json) as unknown)
  if (!program) throw new Error("Invalid turtle program JSON")
  return program
}

export function isTurtleProgram(value: unknown): value is TurtleProgram {
  return normalizeTurtleProgram(value) !== null
}

function normalizeBlocks(values: unknown[]): TurtleBlock[] {
  return values.flatMap((value, index) => {
    const block = normalizeBlock(value, index)
    return block ? [block] : []
  })
}

function normalizeBlock(value: unknown, index: number): TurtleBlock | null {
  const record = toRecord(value)
  const type = record?.type
  if (!record || typeof type !== "string" || !isBlockType(type)) return null

  const args = normalizeArgs(record)
  const id = stringValue(record.id) ?? `${type}-${index}`

  switch (type) {
    case "forward":
    case "backward":
      return { id, type, args: { distance: finiteNumber(args.distance, 0) } }
    case "turn_left":
    case "turn_right":
      return { id, type, args: { degrees: finiteNumber(args.degrees, 0) } }
    case "pen_up":
    case "pen_down":
    case "clear":
      return { id, type, args: {} }
    case "set_color":
      return { id, type, args: { color: colorValue(args.color) } }
    case "set_stroke_width":
      return { id, type, args: { width: finiteNumber(args.width ?? args.stroke_width, DEFAULT_STROKE_WIDTH) } }
    case "goto":
      return { id, type, args: { x: finiteNumber(args.x, 0), y: finiteNumber(args.y, 0) } }
    case "set_heading":
      return { id, type, args: { degrees: finiteNumber(args.degrees ?? args.heading, 0) } }
    case "repeat": {
      const childValues = arrayFromRecord(record, "children").length > 0 ? arrayFromRecord(record, "children") : arrayFromRecord(record, "blocks")
      return {
        id,
        type,
        args: { times: Math.max(0, Math.floor(finiteNumber(args.times ?? record.count, 0))) },
        children: normalizeBlocks(childValues),
      }
    }
    case "wait":
      return { id, type, args: { duration_ms: Math.max(0, finiteNumber(args.duration_ms ?? args.duration, 0)) } }
  }
}

function normalizeTraceStep(value: unknown, index: number, fallbackState: TurtleState): TraceStep[] {
  const record = toRecord(value)
  if (!record) return []

  const blockType = stringValue(record.block_type) ?? stringValue(record.blockType) ?? stringValue(record.type)
  if (!blockType || !isBlockType(blockType)) return []

  const before = normalizeTurtleState(record.before, fallbackState)
  const after = normalizeTurtleState(record.after, before)
  const drawLine = normalizeDrawLine(record.draw_line ?? record.drawLine)

  return [
    {
      step_index: finiteNumber(record.step_index ?? record.stepIndex, index),
      block_id: stringValue(record.block_id) ?? stringValue(record.blockId) ?? stringValue(record.id) ?? `${blockType}-${index}`,
      block_type: blockType,
      before,
      after,
      draw_line: drawLine,
      duration_ms: Math.max(0, finiteNumber(record.duration_ms ?? record.durationMs, 0)),
    },
  ]
}

function normalizeDrawLine(value: unknown): DrawLine | null {
  const record = toRecord(value)
  if (!record) return null

  const fromX = finiteNumber(record.from_x ?? record.fromX, Number.NaN)
  const fromY = finiteNumber(record.from_y ?? record.fromY, Number.NaN)
  const toX = finiteNumber(record.to_x ?? record.toX, Number.NaN)
  const toY = finiteNumber(record.to_y ?? record.toY, Number.NaN)
  if (![fromX, fromY, toX, toY].every(Number.isFinite)) return null

  return {
    from_x: fromX,
    from_y: fromY,
    to_x: toX,
    to_y: toY,
    color: colorValue(record.color),
    stroke_width: finiteNumber(record.stroke_width ?? record.strokeWidth, DEFAULT_STROKE_WIDTH),
  }
}

function normalizeTurtleState(value: unknown, fallback: TurtleState): TurtleState {
  const record = toRecord(value)
  if (!record) return cloneState(fallback)

  return {
    x: finiteNumber(record.x, fallback.x),
    y: finiteNumber(record.y, fallback.y),
    heading: normalizeHeading(finiteNumber(record.heading ?? record.heading_deg ?? record.headingDeg, fallback.heading)),
    pen_down: typeof record.pen_down === "boolean" ? record.pen_down : typeof record.penDown === "boolean" ? record.penDown : fallback.pen_down,
    stroke_color: colorValue(record.stroke_color ?? record.strokeColor ?? record.color ?? fallback.stroke_color),
    stroke_width: finiteNumber(record.stroke_width ?? record.strokeWidth, fallback.stroke_width),
  }
}

function normalizeArgs(record: ProgramRecord): CanonicalBlockArgs {
  const args = toRecord(record.args)
  return {
    ...record,
    ...args,
  } as CanonicalBlockArgs
}

function readCanvas(record: ProgramRecord | null): Partial<TurtleCanvasSpec> {
  const canvas = toRecord(record?.canvas)
  return {
    width: numberValue(canvas?.width) ?? numberValue(record?.canvas_width) ?? numberValue(record?.canvasWidth),
    height: numberValue(canvas?.height) ?? numberValue(record?.canvas_height) ?? numberValue(record?.canvasHeight),
    background_color:
      stringValue(canvas?.background_color) ??
      stringValue(canvas?.backgroundColor) ??
      stringValue(record?.background_color) ??
      stringValue(record?.backgroundColor),
  }
}

function normalizeCanvas(canvas: Partial<TurtleCanvasSpec>): TurtleCanvasSpec {
  return {
    width: Math.max(1, finiteNumber(canvas.width, DEFAULT_CANVAS.width)),
    height: Math.max(1, finiteNumber(canvas.height, DEFAULT_CANVAS.height)),
    background_color: canvas.background_color ?? DEFAULT_CANVAS.background_color,
  }
}

function moveTurtle(state: TurtleState, distance: number): DrawLine | null {
  const radians = (normalizeHeading(state.heading) * Math.PI) / 180
  return gotoTurtle(state, state.x + Math.cos(radians) * distance, state.y - Math.sin(radians) * distance)
}

function gotoTurtle(state: TurtleState, x: number, y: number): DrawLine | null {
  const before = cloneState(state)
  state.x = x
  state.y = y

  if (!before.pen_down) return null

  return {
    from_x: before.x,
    from_y: before.y,
    to_x: x,
    to_y: y,
    color: before.stroke_color,
    stroke_width: before.stroke_width,
  }
}

function getVisibleTrace(trace: TraceStep[], stepIndex?: number): TraceStep[] {
  if (stepIndex === undefined) return trace
  return trace.filter((step) => step.step_index <= stepIndex)
}

function paintBackground(ctx: CanvasRenderingContext2D, canvas: TurtleCanvasSpec, options: DrawTraceOptions): void {
  ctx.fillStyle = options.backgroundColor ?? canvas.background_color ?? DEFAULT_CANVAS.background_color ?? "#ffffff"
  ctx.fillRect(0, 0, canvas.width, canvas.height)

  if (options.targetImage) {
    ctx.save()
    ctx.globalAlpha = options.targetImageOpacity ?? 0.28
    ctx.drawImage(options.targetImage, 0, 0, canvas.width, canvas.height)
    ctx.restore()
  }
}

function drawLine(ctx: CanvasRenderingContext2D, line: DrawLine): void {
  ctx.beginPath()
  ctx.moveTo(line.from_x, line.from_y)
  ctx.lineTo(line.to_x, line.to_y)
  ctx.strokeStyle = line.color
  ctx.lineWidth = Math.max(1, line.stroke_width)
  ctx.lineCap = "round"
  ctx.lineJoin = "round"
  ctx.stroke()
}

function drawTurtle(ctx: CanvasRenderingContext2D, state: TurtleState): void {
  const radians = (-normalizeHeading(state.heading) * Math.PI) / 180

  ctx.save()
  ctx.translate(state.x, state.y)
  ctx.rotate(radians)
  ctx.beginPath()
  ctx.moveTo(9, 0)
  ctx.lineTo(-6, -5)
  ctx.lineTo(-4, 0)
  ctx.lineTo(-6, 5)
  ctx.closePath()
  ctx.fillStyle = "#10b981"
  ctx.strokeStyle = "#064e3b"
  ctx.lineWidth = 1.5
  ctx.fill()
  ctx.stroke()
  ctx.restore()
}

function countBlocks(blocks: TurtleBlock[]): number {
  return blocks.reduce((total, block) => total + 1 + (block.type === "repeat" ? countBlocks(block.children) : 0), 0)
}

function cloneState(state: TurtleState): TurtleState {
  return { ...state }
}

function colorValue(value: unknown): string {
  if (typeof value === "string" && value.trim()) return value

  const color = toRecord(value)
  const r = numberValue(color?.r) ?? numberValue(color?.red) ?? 0
  const g = numberValue(color?.g) ?? numberValue(color?.green) ?? 0
  const b = numberValue(color?.b) ?? numberValue(color?.blue) ?? 0
  const a = numberValue(color?.a) ?? numberValue(color?.alpha)

  if (a === undefined || a === 255) return `#${hexByte(r)}${hexByte(g)}${hexByte(b)}`
  return `rgba(${clampColor(r)}, ${clampColor(g)}, ${clampColor(b)}, ${clampAlpha(a)})`
}

function hexByte(value: number): string {
  return clampColor(value).toString(16).padStart(2, "0")
}

function clampColor(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)))
}

function clampAlpha(value: number): number {
  return value > 1 ? Math.max(0, Math.min(1, value / 255)) : Math.max(0, Math.min(1, value))
}

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function arrayFromRecord(record: ProgramRecord | null, key: string): unknown[] {
  const child = record?.[key]
  return Array.isArray(child) ? child : []
}

function toRecord(value: unknown): ProgramRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as ProgramRecord) : null
}

function isBlockType(value: string): value is TurtleBlockType {
  return (
    value === "forward" ||
    value === "backward" ||
    value === "turn_left" ||
    value === "turn_right" ||
    value === "pen_up" ||
    value === "pen_down" ||
    value === "set_color" ||
    value === "set_stroke_width" ||
    value === "goto" ||
    value === "set_heading" ||
    value === "repeat" ||
    value === "clear" ||
    value === "wait"
  )
}
