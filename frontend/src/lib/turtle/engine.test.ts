import { describe, expect, it } from "vitest"

import {
  interpretProgram,
  normalizeExecutionTrace,
  normalizeTurtleProgram,
  playbackDelayForStep,
  visibleLinesForStep,
} from "./engine"
import type { TraceStep } from "./types"

describe("frontend turtle renderer engine", () => {
  it("interprets backend canonical programs with args and repeat children", () => {
    const program = normalizeTurtleProgram({
      version: 1,
      canvas: { width: 40, height: 30 },
      start: {
        x: 10,
        y: 10,
        heading: 0,
        pen_down: true,
        stroke_color: "#000000",
        stroke_width: 1,
      },
      blocks: [
        { id: "color", type: "set_color", args: { color: "#ff0000" } },
        {
          id: "repeat",
          type: "repeat",
          args: { times: 2 },
          children: [{ id: "forward", type: "forward", args: { distance: 5 } }],
        },
        { id: "wait", type: "wait", args: { duration_ms: 25 } },
      ],
    })

    expect(program).not.toBeNull()
    const trace = interpretProgram(program!)

    expect(trace.steps).toHaveLength(4)
    expect(trace.steps[1]?.draw_line).toMatchObject({
      from_x: 10,
      from_y: 10,
      to_x: 15,
      to_y: 10,
      color: "#ff0000",
    })
    expect(trace.steps[2]?.draw_line).toMatchObject({
      from_x: 15,
      from_y: 10,
      to_x: 20,
      to_y: 10,
    })
    expect(trace.steps[3]?.duration_ms).toBe(25)
  })

  it("normalizes flattened legacy programs for preview execution", () => {
    const program = normalizeTurtleProgram({
      version: 1,
      canvas_width: 20,
      canvas_height: 20,
      start: {
        x: 5,
        y: 5,
        heading_deg: 90,
        pen_down: true,
        color: "#111111",
        stroke_width: 2,
      },
      blocks: [
        { id: "hidden", type: "pen_up" },
        { id: "move", type: "forward", distance: 4 },
        { id: "draw", type: "pen_down" },
        { id: "down", type: "set_heading", degrees: 270 },
        { id: "line", type: "forward", distance: 3 },
      ],
    })

    expect(program?.canvas).toMatchObject({ width: 20, height: 20 })
    const trace = interpretProgram(program!)

    expect(trace.steps[1]?.draw_line).toBeNull()
    expect(trace.steps[4]?.draw_line).toMatchObject({
      from_x: 5,
      from_y: 1,
      to_y: 4,
      stroke_width: 2,
    })
    expect(trace.steps[4]?.draw_line?.to_x).toBeCloseTo(5)
  })

  it("applies clear during playback line selection", () => {
    const trace = normalizeExecutionTrace({
      final_state: {
        x: 9,
        y: 1,
        heading_deg: 0,
        pen_down: true,
        color: "#000000",
        stroke_width: 1,
      },
      steps: [
        {
          step_index: 0,
          block_id: "first",
          block_type: "forward",
          before: { x: 0, y: 1, heading_deg: 0, pen_down: true, color: "#000000", stroke_width: 1 },
          after: { x: 4, y: 1, heading_deg: 0, pen_down: true, color: "#000000", stroke_width: 1 },
          draw_line: { from_x: 0, from_y: 1, to_x: 4, to_y: 1, color: "#000000", stroke_width: 1 },
          duration_ms: 0,
        },
        {
          step_index: 1,
          block_id: "clear",
          block_type: "clear",
          before: { x: 4, y: 1, heading_deg: 0, pen_down: true, color: "#000000", stroke_width: 1 },
          after: { x: 4, y: 1, heading_deg: 0, pen_down: true, color: "#000000", stroke_width: 1 },
          draw_line: null,
          duration_ms: 0,
        },
        {
          step_index: 2,
          block_id: "second",
          block_type: "forward",
          before: { x: 4, y: 1, heading_deg: 0, pen_down: true, color: "#000000", stroke_width: 1 },
          after: { x: 9, y: 1, heading_deg: 0, pen_down: true, color: "#000000", stroke_width: 1 },
          draw_line: { from_x: 4, from_y: 1, to_x: 9, to_y: 1, color: "#000000", stroke_width: 1 },
          duration_ms: 0,
        },
      ],
    })

    expect(trace).not.toBeNull()
    expect(visibleLinesForStep(trace!.steps, 0)).toHaveLength(1)
    expect(visibleLinesForStep(trace!.steps, 1)).toHaveLength(0)
    expect(visibleLinesForStep(trace!.steps, 2)).toEqual([
      { from_x: 4, from_y: 1, to_x: 9, to_y: 1, color: "#000000", stroke_width: 1 },
    ])
  })

  it("uses a 200ms playback delay capped at 30 seconds total", () => {
    const step = (duration_ms: number): TraceStep => ({
      step_index: 0,
      block_id: "wait",
      block_type: "wait",
      before: { x: 0, y: 0, heading: 0, pen_down: true, stroke_color: "#000000", stroke_width: 1 },
      after: { x: 0, y: 0, heading: 0, pen_down: true, stroke_color: "#000000", stroke_width: 1 },
      draw_line: null,
      duration_ms,
    })

    expect(playbackDelayForStep(undefined)).toBe(200)
    expect(playbackDelayForStep(step(25))).toBe(200)
    expect(playbackDelayForStep(step(0), 150)).toBe(200)
    expect(playbackDelayForStep(step(0), 300)).toBe(100)
    expect(playbackDelayForStep(undefined, 5_000) * 5_000).toBeLessThanOrEqual(30_000)
  })
})
