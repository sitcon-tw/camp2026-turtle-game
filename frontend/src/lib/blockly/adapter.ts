import * as Blockly from "blockly/core"
import { BLOCK_TYPES } from "./blocks"
import type { BackendBlock, BackendBlockProgram, ChallengeCanvas } from "./types"

export class UnsupportedBlocklyBlockError extends Error {
  constructor(blockType: string) {
    super(`Unsupported Blockly block type: ${blockType}`)
    this.name = "UnsupportedBlocklyBlockError"
  }
}

export type BlocklyToProgramOptions = {
  canvas: ChallengeCanvas
}

export function workspaceToBackendProgram(
  workspace: Blockly.Workspace,
  options: BlocklyToProgramOptions,
): BackendBlockProgram {
  const canvas = normalizeCanvas(options.canvas)

  return {
    version: 1,
    canvas,
    start: {
      x: canvas.width / 2,
      y: canvas.height / 2,
      heading: 0,
      pen_down: true,
      stroke_color: "#000000",
      stroke_width: 1,
    },
    blocks: workspace.getTopBlocks(true).flatMap((block) => blockChainToBackendBlocks(block)),
  }
}

function normalizeCanvas(canvas: ChallengeCanvas): { width: number; height: number } {
  return {
    width: positiveIntegerOrDefault(canvas.width, 480),
    height: positiveIntegerOrDefault(canvas.height, 360),
  }
}

function positiveIntegerOrDefault(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback
}

function blockChainToBackendBlocks(block: Blockly.Block | null): BackendBlock[] {
  const blocks: BackendBlock[] = []
  let current = block

  while (current) {
    blocks.push(...singleBlockToBackendBlocks(current))
    current = current.getNextBlock()
  }

  return blocks
}

function singleBlockToBackendBlocks(block: Blockly.Block): BackendBlock[] {
  switch (block.type) {
    case BLOCK_TYPES.moveUp:
      return directionBlocks(block, 90)
    case BLOCK_TYPES.moveDown:
      return directionBlocks(block, 270)
    case BLOCK_TYPES.moveLeft:
      return directionBlocks(block, 180)
    case BLOCK_TYPES.moveRight:
      return directionBlocks(block, 0)
    case BLOCK_TYPES.forward:
      return [distanceBlock(block, "forward")]
    case BLOCK_TYPES.backward:
      return [distanceBlock(block, "backward")]
    case BLOCK_TYPES.turnLeft:
      return [degreesBlock(block, "turn_left")]
    case BLOCK_TYPES.turnRight:
      return [degreesBlock(block, "turn_right")]
    case BLOCK_TYPES.penUp:
      return [noArgsBlock(block, "pen_up")]
    case BLOCK_TYPES.penDown:
      return [noArgsBlock(block, "pen_down")]
    case BLOCK_TYPES.setColor:
      return [
        {
          id: block.id,
          type: "set_color",
          args: { color: String(block.getFieldValue("COLOR") ?? "#000000") },
        },
      ]
    case BLOCK_TYPES.setStrokeWidth:
      return [
        {
          id: block.id,
          type: "set_stroke_width",
          args: { width: positiveNumberField(block, "WIDTH", 1) },
        },
      ]
    case BLOCK_TYPES.goto:
      return [
        {
          id: block.id,
          type: "goto",
          args: {
            x: numberField(block, "X", 0),
            y: numberField(block, "Y", 0),
          },
        },
      ]
    case BLOCK_TYPES.setHeading:
      return [degreesBlock(block, "set_heading")]
    case BLOCK_TYPES.repeat:
      return [
        {
          id: block.id,
          type: "repeat",
          args: { times: nonNegativeIntegerField(block, "TIMES", 0) },
          children: blockChainToBackendBlocks(block.getInputTargetBlock("DO")),
        },
      ]
    case BLOCK_TYPES.clear:
      return [noArgsBlock(block, "clear")]
    case BLOCK_TYPES.wait:
      return [
        {
          id: block.id,
          type: "wait",
          args: { duration_ms: nonNegativeIntegerField(block, "DURATION_MS", 0) },
        },
      ]
    default:
      throw new UnsupportedBlocklyBlockError(block.type)
  }
}

function directionBlocks(block: Blockly.Block, heading: number): BackendBlock[] {
  const distance = positiveNumberField(block, "DISTANCE", 0)

  return [
    {
      id: `${block.id}:heading`,
      type: "set_heading",
      args: { degrees: heading },
    },
    {
      id: block.id,
      type: "forward",
      args: { distance },
    },
  ]
}

function distanceBlock(
  block: Blockly.Block,
  type: "forward" | "backward",
): BackendBlock {
  return {
    id: block.id,
    type,
    args: { distance: positiveNumberField(block, "DISTANCE", 0) },
  }
}

function degreesBlock(
  block: Blockly.Block,
  type: "turn_left" | "turn_right" | "set_heading",
): BackendBlock {
  return {
    id: block.id,
    type,
    args: { degrees: numberField(block, "DEGREES", 0) },
  }
}

function noArgsBlock(block: Blockly.Block, type: "pen_up" | "pen_down" | "clear"): BackendBlock {
  return {
    id: block.id,
    type,
    args: {},
  }
}

function nonNegativeIntegerField(block: Blockly.Block, fieldName: string, fallback: number): number {
  return Math.max(0, Math.floor(numberField(block, fieldName, fallback)))
}

function positiveNumberField(block: Blockly.Block, fieldName: string, fallback: number): number {
  return Math.max(0, numberField(block, fieldName, fallback))
}

function numberField(block: Blockly.Block, fieldName: string, fallback: number): number {
  const numeric = Number(block.getFieldValue(fieldName))
  return Number.isFinite(numeric) ? numeric : fallback
}
