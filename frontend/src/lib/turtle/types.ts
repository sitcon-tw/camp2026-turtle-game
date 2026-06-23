export type TurtleProgramVersion = 1

export type TurtleBlockType =
  | "forward"
  | "backward"
  | "turn_left"
  | "turn_right"
  | "pen_up"
  | "pen_down"
  | "set_color"
  | "set_stroke_width"
  | "goto"
  | "set_heading"
  | "repeat"
  | "clear"
  | "wait"

export type TurtleCanvasSpec = {
  width: number
  height: number
  background_color?: string
}

export type TurtleState = {
  x: number
  y: number
  heading: number
  pen_down: boolean
  stroke_color: string
  stroke_width: number
}

export type CanonicalBlockArgs = {
  distance?: number
  degrees?: number
  heading?: number
  color?: string
  width?: number
  stroke_width?: number
  x?: number
  y?: number
  times?: number
  duration?: number
  duration_ms?: number
}

export type TurtleBlockBase = {
  id: string
}

export type ForwardBlock = TurtleBlockBase & {
  type: "forward"
  args: { distance: number }
}

export type BackwardBlock = TurtleBlockBase & {
  type: "backward"
  args: { distance: number }
}

export type TurnLeftBlock = TurtleBlockBase & {
  type: "turn_left"
  args: { degrees: number }
}

export type TurnRightBlock = TurtleBlockBase & {
  type: "turn_right"
  args: { degrees: number }
}

export type PenUpBlock = TurtleBlockBase & {
  type: "pen_up"
  args?: Record<string, never>
}

export type PenDownBlock = TurtleBlockBase & {
  type: "pen_down"
  args?: Record<string, never>
}

export type SetColorBlock = TurtleBlockBase & {
  type: "set_color"
  args: { color: string }
}

export type SetStrokeWidthBlock = TurtleBlockBase & {
  type: "set_stroke_width"
  args: { width: number }
}

export type GotoBlock = TurtleBlockBase & {
  type: "goto"
  args: { x: number; y: number }
}

export type SetHeadingBlock = TurtleBlockBase & {
  type: "set_heading"
  args: { degrees: number }
}

export type RepeatBlock = TurtleBlockBase & {
  type: "repeat"
  args: { times: number }
  children: TurtleBlock[]
}

export type ClearBlock = TurtleBlockBase & {
  type: "clear"
  args?: Record<string, never>
}

export type WaitBlock = TurtleBlockBase & {
  type: "wait"
  args: { duration_ms: number }
}

export type TurtleBlock =
  | ForwardBlock
  | BackwardBlock
  | TurnLeftBlock
  | TurnRightBlock
  | PenUpBlock
  | PenDownBlock
  | SetColorBlock
  | SetStrokeWidthBlock
  | GotoBlock
  | SetHeadingBlock
  | RepeatBlock
  | ClearBlock
  | WaitBlock

export type TurtleProgram = {
  version: TurtleProgramVersion
  canvas: TurtleCanvasSpec
  start: TurtleState
  blocks: TurtleBlock[]
}

export type BlockProgram = TurtleProgram

export type DrawLine = {
  from_x: number
  from_y: number
  to_x: number
  to_y: number
  color: string
  stroke_width: number
}

export type TraceStep = {
  step_index: number
  block_id: string
  block_type: TurtleBlockType
  before: TurtleState
  after: TurtleState
  draw_line: DrawLine | null
  duration_ms: number
}

export type ExecutionTrace = {
  final_state: TurtleState
  steps: TraceStep[]
}

export type TurtlePreset = {
  id: string
  name: string
  description: string
  program: TurtleProgram
}

export type TurtleChallengeLike = {
  target_image_asset_id?: string | null
  target_image_url?: string | null
  canvas?: {
    width?: number | null
    height?: number | null
    background_color?: string | null
  } | null
}
