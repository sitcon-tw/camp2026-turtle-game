export type ChallengeCanvas = {
  width: number
  height: number
  background_color?: string | null
}

export type BackendProgramCanvas = {
  width: number
  height: number
}

export type BackendProgramStart = {
  x: number
  y: number
  heading: number
  pen_down: boolean
  stroke_color: string
  stroke_width: number
}

export type BackendBlock =
  | {
      id: string
      type: "forward" | "backward"
      args: { distance: number }
    }
  | {
      id: string
      type: "turn_left" | "turn_right" | "set_heading"
      args: { degrees: number }
    }
  | {
      id: string
      type: "pen_up" | "pen_down" | "clear"
      args: Record<string, never>
    }
  | {
      id: string
      type: "set_color"
      args: { color: string }
    }
  | {
      id: string
      type: "set_stroke_width"
      args: { width: number }
    }
  | {
      id: string
      type: "goto"
      args: { x: number; y: number }
    }
  | {
      id: string
      type: "repeat"
      args: { times: number }
      children: BackendBlock[]
    }
  | {
      id: string
      type: "wait"
      args: { duration_ms: number }
    }

export type BackendBlockProgram = {
  version: 1
  canvas: BackendProgramCanvas
  start: BackendProgramStart
  blocks: BackendBlock[]
}

