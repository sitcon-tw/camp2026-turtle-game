export type TurtleProgramVersion = 1;

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
  | "wait";

export interface TurtleCanvasSpec {
  width: number;
  height: number;
}

export interface TurtleState {
  x: number;
  y: number;
  heading: number;
  pen_down: boolean;
  stroke_color: string;
  stroke_width: number;
}

export interface TurtleBlockBase {
  id?: string;
}

export interface ForwardBlock extends TurtleBlockBase {
  type: "forward";
  distance: number;
}

export interface BackwardBlock extends TurtleBlockBase {
  type: "backward";
  distance: number;
}

export interface TurnLeftBlock extends TurtleBlockBase {
  type: "turn_left";
  degrees: number;
}

export interface TurnRightBlock extends TurtleBlockBase {
  type: "turn_right";
  degrees: number;
}

export interface PenUpBlock extends TurtleBlockBase {
  type: "pen_up";
}

export interface PenDownBlock extends TurtleBlockBase {
  type: "pen_down";
}

export interface SetColorBlock extends TurtleBlockBase {
  type: "set_color";
  color: string;
}

export interface SetStrokeWidthBlock extends TurtleBlockBase {
  type: "set_stroke_width";
  width: number;
}

export interface GotoBlock extends TurtleBlockBase {
  type: "goto";
  x: number;
  y: number;
}

export interface SetHeadingBlock extends TurtleBlockBase {
  type: "set_heading";
  degrees: number;
}

export interface RepeatBlock extends TurtleBlockBase {
  type: "repeat";
  times: number;
  children: TurtleBlock[];
}

export interface ClearBlock extends TurtleBlockBase {
  type: "clear";
}

export interface WaitBlock extends TurtleBlockBase {
  type: "wait";
  duration_ms: number;
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
  | WaitBlock;

export interface TurtleProgram {
  version: TurtleProgramVersion;
  canvas: TurtleCanvasSpec;
  start: TurtleState;
  blocks: TurtleBlock[];
}

export type BlockProgram = TurtleProgram;

export interface DrawLine {
  from_x: number;
  from_y: number;
  to_x: number;
  to_y: number;
  color: string;
  stroke_width: number;
}

export interface TraceStep {
  step_index: number;
  block_id: string;
  block_type: TurtleBlockType;
  before: TurtleState;
  after: TurtleState;
  draw_line: DrawLine | null;
  duration_ms: number;
}

export interface TurtlePreset {
  id: string;
  name: string;
  description: string;
  program: TurtleProgram;
}
