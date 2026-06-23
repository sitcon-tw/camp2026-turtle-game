import * as Blockly from "blockly/core"
import { afterEach, describe, expect, it } from "vitest"
import { BLOCK_TYPES, registerTurtleBlocks } from "./blocks"
import {
  createWorkspaceFromXml,
  deserializeWorkspaceFromXml,
  serializeWorkspaceToXml,
} from "./serialization"

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

describe("Blockly XML workspace serialization", () => {
  it("serializes an empty workspace deterministically", () => {
    const current = workspace()

    expect(serializeWorkspaceToXml(current)).toBe('<xml xmlns="https://developers.google.com/blockly/xml"></xml>')
  })

  it("round trips connected block order", () => {
    const current = workspace()
    const first = current.newBlock(BLOCK_TYPES.moveRight, "move-right")
    const second = current.newBlock(BLOCK_TYPES.moveUp, "move-up")
    first.setFieldValue(12, "DISTANCE")
    second.setFieldValue(8, "DISTANCE")
    first.nextConnection?.connect(second.previousConnection!)

    const xml = serializeWorkspaceToXml(current)
    const restored = workspace()
    deserializeWorkspaceFromXml(restored, xml)

    const topBlocks = restored.getTopBlocks(true)
    expect(topBlocks).toHaveLength(1)
    expect(topBlocks[0]?.type).toBe(BLOCK_TYPES.moveRight)
    expect(topBlocks[0]?.getFieldValue("DISTANCE")).toBe(12)
    expect(topBlocks[0]?.getNextBlock()?.type).toBe(BLOCK_TYPES.moveUp)
    expect(topBlocks[0]?.getNextBlock()?.getFieldValue("DISTANCE")).toBe(8)
  })

  it("round trips repeat child order", () => {
    const current = workspace()
    const repeat = current.newBlock(BLOCK_TYPES.repeat, "repeat")
    const childForward = current.newBlock(BLOCK_TYPES.forward, "child-forward")
    const childTurn = current.newBlock(BLOCK_TYPES.turnLeft, "child-turn")
    repeat.setFieldValue(3, "TIMES")
    childForward.setFieldValue(5, "DISTANCE")
    childTurn.setFieldValue(90, "DEGREES")
    repeat.getInput("DO")?.connection?.connect(childForward.previousConnection!)
    childForward.nextConnection?.connect(childTurn.previousConnection!)

    const restored = createWorkspaceFromXml(serializeWorkspaceToXml(current))
    workspaces.push(restored)
    const restoredRepeat = restored.getTopBlocks(true)[0]
    const restoredChild = restoredRepeat?.getInputTargetBlock("DO")

    expect(restoredRepeat?.type).toBe(BLOCK_TYPES.repeat)
    expect(restoredRepeat?.getFieldValue("TIMES")).toBe(3)
    expect(restoredChild?.type).toBe(BLOCK_TYPES.forward)
    expect(restoredChild?.getNextBlock()?.type).toBe(BLOCK_TYPES.turnLeft)
  })
})
