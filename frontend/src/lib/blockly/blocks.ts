import * as Blockly from "blockly/core"

export const BLOCK_TYPES = {
  moveUp: "turtle_move_up",
  moveDown: "turtle_move_down",
  moveLeft: "turtle_move_left",
  moveRight: "turtle_move_right",
  forward: "turtle_forward",
  backward: "turtle_backward",
  turnLeft: "turtle_turn_left",
  turnRight: "turtle_turn_right",
  penUp: "turtle_pen_up",
  penDown: "turtle_pen_down",
  setColor: "turtle_set_color",
  setStrokeWidth: "turtle_set_stroke_width",
  goto: "turtle_goto",
  setHeading: "turtle_set_heading",
  repeat: "turtle_repeat",
  clear: "turtle_clear",
  wait: "turtle_wait",
} as const

export type TurtleBlocklyBlockType = (typeof BLOCK_TYPES)[keyof typeof BLOCK_TYPES]

let registered = false

export function registerTurtleBlocks(): void {
  if (registered) {
    return
  }

  registerStatementBlock(BLOCK_TYPES.moveUp, function () {
    this.appendDummyInput().appendField("向上移動").appendField(numberField(10, 0), "DISTANCE")
    setBlockMetadata(this, 210, "將海龜朝上移動指定距離")
  })
  registerStatementBlock(BLOCK_TYPES.moveDown, function () {
    this.appendDummyInput().appendField("向下移動").appendField(numberField(10, 0), "DISTANCE")
    setBlockMetadata(this, 210, "將海龜朝下移動指定距離")
  })
  registerStatementBlock(BLOCK_TYPES.moveLeft, function () {
    this.appendDummyInput().appendField("向左移動").appendField(numberField(10, 0), "DISTANCE")
    setBlockMetadata(this, 210, "將海龜朝左移動指定距離")
  })
  registerStatementBlock(BLOCK_TYPES.moveRight, function () {
    this.appendDummyInput().appendField("向右移動").appendField(numberField(10, 0), "DISTANCE")
    setBlockMetadata(this, 210, "將海龜朝右移動指定距離")
  })
  registerStatementBlock(BLOCK_TYPES.forward, function () {
    this.appendDummyInput().appendField("前進").appendField(numberField(10, 0), "DISTANCE")
    setBlockMetadata(this, 210, "依目前方向前進")
  })
  registerStatementBlock(BLOCK_TYPES.backward, function () {
    this.appendDummyInput().appendField("後退").appendField(numberField(10, 0), "DISTANCE")
    setBlockMetadata(this, 210, "依目前方向後退")
  })
  registerStatementBlock(BLOCK_TYPES.turnLeft, function () {
    this.appendDummyInput().appendField("左轉").appendField(numberField(90), "DEGREES").appendField("度")
    setBlockMetadata(this, 210, "向左旋轉指定角度")
  })
  registerStatementBlock(BLOCK_TYPES.turnRight, function () {
    this.appendDummyInput().appendField("右轉").appendField(numberField(90), "DEGREES").appendField("度")
    setBlockMetadata(this, 210, "向右旋轉指定角度")
  })
  registerStatementBlock(BLOCK_TYPES.penUp, function () {
    this.appendDummyInput().appendField("抬筆")
    setBlockMetadata(this, 160, "移動時不要畫線")
  })
  registerStatementBlock(BLOCK_TYPES.penDown, function () {
    this.appendDummyInput().appendField("下筆")
    setBlockMetadata(this, 160, "移動時畫線")
  })
  registerStatementBlock(BLOCK_TYPES.setColor, function () {
    this.appendDummyInput().appendField("設定顏色").appendField(new Blockly.FieldTextInput("#000000"), "COLOR")
    setBlockMetadata(this, 160, "設定畫筆顏色")
  })
  registerStatementBlock(BLOCK_TYPES.setStrokeWidth, function () {
    this.appendDummyInput().appendField("設定筆寬").appendField(numberField(1, 1), "WIDTH")
    setBlockMetadata(this, 160, "設定畫線粗細")
  })
  registerStatementBlock(BLOCK_TYPES.goto, function () {
    this.appendDummyInput()
      .appendField("移到 x")
      .appendField(numberField(0), "X")
      .appendField("y")
      .appendField(numberField(0), "Y")
    setBlockMetadata(this, 210, "移動到指定座標")
  })
  registerStatementBlock(BLOCK_TYPES.setHeading, function () {
    this.appendDummyInput().appendField("面向").appendField(numberField(0), "DEGREES").appendField("度")
    setBlockMetadata(this, 210, "設定海龜方向")
  })
  registerStatementBlock(BLOCK_TYPES.repeat, function () {
    this.appendDummyInput().appendField("重複").appendField(numberField(4, 0, 1), "TIMES").appendField("次")
    this.appendStatementInput("DO")
    setBlockMetadata(this, 120, "重複執行裡面的積木")
  })
  registerStatementBlock(BLOCK_TYPES.clear, function () {
    this.appendDummyInput().appendField("清除畫面")
    setBlockMetadata(this, 160, "清除目前畫面")
  })
  registerStatementBlock(BLOCK_TYPES.wait, function () {
    this.appendDummyInput().appendField("等待").appendField(numberField(250, 0, 1), "DURATION_MS").appendField("毫秒")
    setBlockMetadata(this, 120, "播放時等待指定時間")
  })

  registered = true
}

function registerStatementBlock(type: TurtleBlocklyBlockType, init: (this: Blockly.Block) => void) {
  Blockly.Blocks[type] = {
    init,
  }
}

function numberField(value: number, min?: number, precision?: number) {
  return new Blockly.FieldNumber(value, min, undefined, precision)
}

function setBlockMetadata(block: Blockly.Block, colour: number, tooltip: string) {
  block.setPreviousStatement(true)
  block.setNextStatement(true)
  block.setColour(colour)
  block.setTooltip(tooltip)
  block.setHelpUrl("")
}
