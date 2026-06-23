import * as Blockly from "blockly/core"
import { afterEach, describe, expect, it } from "vitest"
import { UnsupportedBlocklyBlockError, workspaceToBackendProgram } from "./adapter"
import { BLOCK_TYPES, registerTurtleBlocks } from "./blocks"

const workspaces: Blockly.Workspace[] = []

function workspace(): Blockly.Workspace {
  registerTurtleBlocks()
  const created = new Blockly.Workspace()
  workspaces.push(created)
  return created
}

afterEach(() => {
  for (const current of workspaces.splice(0)) {
    current.dispose()
  }
})

describe("Blockly to backend program adapter", () => {
  it("builds a canonical backend program with a canvas-centered default start", () => {
    const current = workspace()

    expect(
      workspaceToBackendProgram(current, {
        canvas: { width: 32, height: 24, background_color: "#ffffff" },
      }),
    ).toEqual({
      version: 1,
      canvas: { width: 32, height: 24 },
      start: {
        x: 16,
        y: 12,
        heading: 0,
        pen_down: true,
        stroke_color: "#000000",
        stroke_width: 1,
      },
      blocks: [],
    })
  })

  it("preserves top-level block order and backend action fields", () => {
    const current = workspace()
    const color = current.newBlock(BLOCK_TYPES.setColor, "color")
    const width = current.newBlock(BLOCK_TYPES.setStrokeWidth, "width")
    const forward = current.newBlock(BLOCK_TYPES.forward, "forward")
    color.setFieldValue("#ff0000", "COLOR")
    width.setFieldValue(3, "WIDTH")
    forward.setFieldValue(7, "DISTANCE")
    color.nextConnection?.connect(width.previousConnection!)
    width.nextConnection?.connect(forward.previousConnection!)

    const program = workspaceToBackendProgram(current, { canvas: { width: 100, height: 80 } })

    expect(program.blocks).toEqual([
      { id: "color", type: "set_color", args: { color: "#ff0000" } },
      { id: "width", type: "set_stroke_width", args: { width: 3 } },
      { id: "forward", type: "forward", args: { distance: 7 } },
    ])
  })

  it("lowers directional movement into set_heading plus forward blocks", () => {
    const current = workspace()
    const up = current.newBlock(BLOCK_TYPES.moveUp, "up")
    const left = current.newBlock(BLOCK_TYPES.moveLeft, "left")
    up.setFieldValue(4, "DISTANCE")
    left.setFieldValue(9, "DISTANCE")
    up.nextConnection?.connect(left.previousConnection!)

    const program = workspaceToBackendProgram(current, { canvas: { width: 100, height: 80 } })

    expect(program.blocks).toEqual([
      { id: "up:heading", type: "set_heading", args: { degrees: 90 } },
      { id: "up", type: "forward", args: { distance: 4 } },
      { id: "left:heading", type: "set_heading", args: { degrees: 180 } },
      { id: "left", type: "forward", args: { distance: 9 } },
    ])
  })

  it("converts repeat children with canonical args and children", () => {
    const current = workspace()
    const repeat = current.newBlock(BLOCK_TYPES.repeat, "repeat")
    const down = current.newBlock(BLOCK_TYPES.moveDown, "down")
    const turn = current.newBlock(BLOCK_TYPES.turnRight, "turn")
    repeat.setFieldValue(2, "TIMES")
    down.setFieldValue(6, "DISTANCE")
    turn.setFieldValue(45, "DEGREES")
    repeat.getInput("DO")?.connection?.connect(down.previousConnection!)
    down.nextConnection?.connect(turn.previousConnection!)

    const program = workspaceToBackendProgram(current, { canvas: { width: 100, height: 80 } })

    expect(program.blocks).toEqual([
      {
        id: "repeat",
        type: "repeat",
        args: { times: 2 },
        children: [
          { id: "down:heading", type: "set_heading", args: { degrees: 270 } },
          { id: "down", type: "forward", args: { distance: 6 } },
          { id: "turn", type: "turn_right", args: { degrees: 45 } },
        ],
      },
    ])
  })

  it("throws for unsupported Blockly block types", () => {
    const current = workspace()
    if (!Blockly.Blocks.adapter_unsupported_test) {
      Blockly.common.defineBlocksWithJsonArray([
        {
          type: "adapter_unsupported_test",
          message0: "unsupported",
          previousStatement: null,
          nextStatement: null,
        },
      ])
    }
    current.newBlock("adapter_unsupported_test", "unsupported")

    expect(() => workspaceToBackendProgram(current, { canvas: { width: 100, height: 80 } })).toThrow(
      UnsupportedBlocklyBlockError,
    )
  })
})
