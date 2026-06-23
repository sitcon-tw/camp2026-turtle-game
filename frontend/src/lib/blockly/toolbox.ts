import type { utils } from "blockly"
import { BLOCK_TYPES } from "./blocks"

export const turtleToolbox: utils.toolbox.ToolboxInfo = {
  kind: "categoryToolbox",
  contents: [
    {
      kind: "category",
      name: "動作",
      colour: "#4c97ff",
      contents: [
        { kind: "block", type: BLOCK_TYPES.moveUp },
        { kind: "block", type: BLOCK_TYPES.moveDown },
        { kind: "block", type: BLOCK_TYPES.moveLeft },
        { kind: "block", type: BLOCK_TYPES.moveRight },
        { kind: "block", type: BLOCK_TYPES.forward },
        { kind: "block", type: BLOCK_TYPES.backward },
        { kind: "block", type: BLOCK_TYPES.turnLeft },
        { kind: "block", type: BLOCK_TYPES.turnRight },
        { kind: "block", type: BLOCK_TYPES.setHeading },
        { kind: "block", type: BLOCK_TYPES.goto },
      ],
    },
    {
      kind: "category",
      name: "畫筆",
      colour: "#0fbd8c",
      contents: [
        { kind: "block", type: BLOCK_TYPES.penDown },
        { kind: "block", type: BLOCK_TYPES.penUp },
        { kind: "block", type: BLOCK_TYPES.setColor },
        { kind: "block", type: BLOCK_TYPES.setStrokeWidth },
        { kind: "block", type: BLOCK_TYPES.clear },
      ],
    },
    {
      kind: "category",
      name: "控制",
      colour: "#ffab19",
      contents: [
        { kind: "block", type: BLOCK_TYPES.repeat },
        { kind: "block", type: BLOCK_TYPES.wait },
      ],
    },
  ],
}

export const reactBlocklyToolboxCategories = turtleToolbox

