import type {
  DrawLine,
  TraceStep,
  TurtleBlock,
  TurtleBlockType,
  TurtleCanvasSpec,
  TurtleProgram,
  TurtleState,
} from "./types";

export interface DrawTraceOptions {
  canvas?: TurtleCanvasSpec;
  stepIndex?: number;
  scaleToFit?: boolean;
  backgroundColor?: string;
  targetImage?: CanvasImageSource | null;
  targetImageOpacity?: number;
  showTurtle?: boolean;
  turtleState?: TurtleState;
}

type ProgramRecord = Record<string, unknown>;

const DEFAULT_CANVAS: TurtleCanvasSpec = {
  width: 640,
  height: 480,
};

const DEFAULT_STROKE_COLOR = "#111827";
const DEFAULT_STROKE_WIDTH = 3;

export function createDefaultProgram(canvas: Partial<TurtleCanvasSpec> = {}): TurtleProgram {
  const normalizedCanvas = normalizeCanvas(canvas);

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
  };
}

export function interpretProgram(program: TurtleProgram): TraceStep[] {
  const trace: TraceStep[] = [];
  let state = cloneState(program.start);

  const addStep = (block: TurtleBlock, before: TurtleState, after: TurtleState, drawLine: DrawLine | null, durationMs = 0) => {
    trace.push({
      step_index: trace.length,
      block_id: block.id ?? `step-${trace.length}`,
      block_type: block.type,
      before,
      after,
      draw_line: drawLine,
      duration_ms: Math.max(0, durationMs),
    });
  };

  const runBlocks = (blocks: TurtleBlock[]) => {
    for (const block of blocks) {
      if (block.type === "repeat") {
        const times = Math.max(0, Math.floor(toFiniteNumber(block.times, 0)));

        for (let index = 0; index < times; index += 1) {
          runBlocks(block.children);
        }

        continue;
      }

      const before = cloneState(state);
      let after = cloneState(state);
      let drawLine: DrawLine | null = null;
      let durationMs = 0;

      switch (block.type) {
        case "forward": {
          after = moveState(state, toFiniteNumber(block.distance, 0));
          drawLine = createDrawLine(before, after);
          break;
        }
        case "backward": {
          after = moveState(state, -toFiniteNumber(block.distance, 0));
          drawLine = createDrawLine(before, after);
          break;
        }
        case "turn_left": {
          after.heading = normalizeHeading(state.heading + toFiniteNumber(block.degrees, 0));
          break;
        }
        case "turn_right": {
          after.heading = normalizeHeading(state.heading - toFiniteNumber(block.degrees, 0));
          break;
        }
        case "pen_up": {
          after.pen_down = false;
          break;
        }
        case "pen_down": {
          after.pen_down = true;
          break;
        }
        case "set_color": {
          after.stroke_color = block.color;
          break;
        }
        case "set_stroke_width": {
          after.stroke_width = Math.max(0, toFiniteNumber(block.width, state.stroke_width));
          break;
        }
        case "goto": {
          after.x = toFiniteNumber(block.x, state.x);
          after.y = toFiniteNumber(block.y, state.y);
          drawLine = createDrawLine(before, after);
          break;
        }
        case "set_heading": {
          after.heading = normalizeHeading(block.degrees);
          break;
        }
        case "clear": {
          break;
        }
        case "wait": {
          durationMs = toFiniteNumber(block.duration_ms, 0);
          break;
        }
      }

      addStep(block, before, after, drawLine, durationMs);
      state = cloneState(after);
    }
  };

  runBlocks(program.blocks);
  return trace;
}

export function drawTraceToCanvas(ctx: CanvasRenderingContext2D, trace: TraceStep[], options: DrawTraceOptions = {}): void {
  const outputWidth = ctx.canvas.width;
  const outputHeight = ctx.canvas.height;
  const canvas = normalizeCanvas(options.canvas ?? { width: outputWidth, height: outputHeight });
  const scaleToFit = options.scaleToFit ?? true;
  const scale = scaleToFit ? Math.min(outputWidth / canvas.width, outputHeight / canvas.height) : 1;
  const offsetX = scaleToFit ? (outputWidth - canvas.width * scale) / 2 : 0;
  const offsetY = scaleToFit ? (outputHeight - canvas.height * scale) / 2 : 0;
  const visibleTrace = getVisibleTrace(trace, options.stepIndex);
  const finalState = options.turtleState ?? visibleTrace.at(-1)?.after ?? trace[0]?.before;

  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, outputWidth, outputHeight);
  ctx.translate(offsetX, offsetY);
  ctx.scale(scale, scale);

  paintBackground(ctx, canvas, options);

  for (const step of visibleTrace) {
    if (step.block_type === "clear") {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      paintBackground(ctx, canvas, options);
      continue;
    }

    if (step.draw_line) {
      drawLine(ctx, step.draw_line);
    }
  }

  if (options.showTurtle && finalState) {
    drawTurtle(ctx, finalState);
  }

  ctx.restore();
}

export function normalizeHeading(degrees: number): number {
  const normalized = toFiniteNumber(degrees, 0) % 360;

  return normalized < 0 ? normalized + 360 : normalized;
}

export function cloneTurtleProgram(program: TurtleProgram): TurtleProgram {
  return JSON.parse(JSON.stringify(program)) as TurtleProgram;
}

export function serializeTurtleProgram(program: TurtleProgram, space = 2): string {
  return JSON.stringify(program, null, space);
}

export function parseTurtleProgramJson(json: string): TurtleProgram {
  const value = JSON.parse(json) as unknown;

  if (!isTurtleProgram(value)) {
    throw new Error("Invalid turtle program JSON");
  }

  return cloneTurtleProgram(value);
}

export function isTurtleProgram(value: unknown): value is TurtleProgram {
  if (!isRecord(value) || value.version !== 1 || !isCanvasSpec(value.canvas) || !isTurtleState(value.start)) {
    return false;
  }

  return Array.isArray(value.blocks) && value.blocks.every(isTurtleBlock);
}

function moveState(state: TurtleState, distance: number): TurtleState {
  const radians = (normalizeHeading(state.heading) * Math.PI) / 180;

  return {
    ...state,
    x: state.x + Math.cos(radians) * distance,
    y: state.y - Math.sin(radians) * distance,
  };
}

function createDrawLine(before: TurtleState, after: TurtleState): DrawLine | null {
  if (!before.pen_down || (before.x === after.x && before.y === after.y)) {
    return null;
  }

  return {
    from_x: before.x,
    from_y: before.y,
    to_x: after.x,
    to_y: after.y,
    color: before.stroke_color,
    stroke_width: before.stroke_width,
  };
}

function getVisibleTrace(trace: TraceStep[], stepIndex?: number): TraceStep[] {
  if (stepIndex === undefined) {
    return trace;
  }

  return trace.filter((step) => step.step_index <= stepIndex);
}

function paintBackground(ctx: CanvasRenderingContext2D, canvas: TurtleCanvasSpec, options: DrawTraceOptions): void {
  if (options.backgroundColor) {
    ctx.fillStyle = options.backgroundColor;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }

  if (options.targetImage) {
    ctx.save();
    ctx.globalAlpha = options.targetImageOpacity ?? 0.28;
    ctx.drawImage(options.targetImage, 0, 0, canvas.width, canvas.height);
    ctx.restore();
  }
}

function drawLine(ctx: CanvasRenderingContext2D, line: DrawLine): void {
  ctx.beginPath();
  ctx.moveTo(line.from_x, line.from_y);
  ctx.lineTo(line.to_x, line.to_y);
  ctx.strokeStyle = line.color;
  ctx.lineWidth = Math.max(0, line.stroke_width);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.stroke();
}

function drawTurtle(ctx: CanvasRenderingContext2D, state: TurtleState): void {
  const radians = (-normalizeHeading(state.heading) * Math.PI) / 180;

  ctx.save();
  ctx.translate(state.x, state.y);
  ctx.rotate(radians);
  ctx.beginPath();
  ctx.moveTo(12, 0);
  ctx.lineTo(-8, -7);
  ctx.lineTo(-5, 0);
  ctx.lineTo(-8, 7);
  ctx.closePath();
  ctx.fillStyle = "#10b981";
  ctx.strokeStyle = "#064e3b";
  ctx.lineWidth = 2;
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

function cloneState(state: TurtleState): TurtleState {
  return { ...state };
}

function normalizeCanvas(canvas: Partial<TurtleCanvasSpec>): TurtleCanvasSpec {
  return {
    width: Math.max(1, toFiniteNumber(canvas.width, DEFAULT_CANVAS.width)),
    height: Math.max(1, toFiniteNumber(canvas.height, DEFAULT_CANVAS.height)),
  };
}

function toFiniteNumber(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) ? Number(value) : fallback;
}

function isCanvasSpec(value: unknown): value is TurtleCanvasSpec {
  return isRecord(value) && typeof value.width === "number" && typeof value.height === "number";
}

function isTurtleState(value: unknown): value is TurtleState {
  return (
    isRecord(value) &&
    typeof value.x === "number" &&
    typeof value.y === "number" &&
    typeof value.heading === "number" &&
    typeof value.pen_down === "boolean" &&
    typeof value.stroke_color === "string" &&
    typeof value.stroke_width === "number"
  );
}

function isTurtleBlock(value: unknown): value is TurtleBlock {
  if (!isRecord(value) || typeof value.type !== "string" || !isBlockType(value.type)) {
    return false;
  }

  switch (value.type) {
    case "forward":
    case "backward":
      return typeof value.distance === "number";
    case "turn_left":
    case "turn_right":
    case "set_heading":
      return typeof value.degrees === "number";
    case "pen_up":
    case "pen_down":
    case "clear":
      return true;
    case "set_color":
      return typeof value.color === "string";
    case "set_stroke_width":
      return typeof value.width === "number";
    case "goto":
      return typeof value.x === "number" && typeof value.y === "number";
    case "repeat":
      return typeof value.times === "number" && Array.isArray(value.children) && value.children.every(isTurtleBlock);
    case "wait":
      return typeof value.duration_ms === "number";
  }
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
  );
}

function isRecord(value: unknown): value is ProgramRecord {
  return typeof value === "object" && value !== null;
}
