import type { TurtlePreset, TurtleProgram } from "./types"

export const defaultCanvas = {
  width: 640,
  height: 480,
  background_color: "#ffffff",
} as const

export const squareProgram: TurtleProgram = {
  version: 1,
  canvas: defaultCanvas,
  start: {
    x: 220,
    y: 320,
    heading: 0,
    pen_down: true,
    stroke_color: "#0f766e",
    stroke_width: 5,
  },
  blocks: [
    {
      id: "square-repeat",
      type: "repeat",
      args: { times: 4 },
      children: [
        { id: "square-forward", type: "forward", args: { distance: 180 } },
        { id: "square-left", type: "turn_left", args: { degrees: 90 } },
      ],
    },
  ],
}

export const flowerProgram: TurtleProgram = {
  version: 1,
  canvas: defaultCanvas,
  start: {
    x: 320,
    y: 280,
    heading: 0,
    pen_down: true,
    stroke_color: "#db2777",
    stroke_width: 3,
  },
  blocks: [
    {
      id: "flower-repeat",
      type: "repeat",
      args: { times: 18 },
      children: [
        { id: "flower-forward-a", type: "forward", args: { distance: 90 } },
        { id: "flower-left-a", type: "turn_left", args: { degrees: 60 } },
        { id: "flower-forward-b", type: "forward", args: { distance: 90 } },
        { id: "flower-left-b", type: "turn_left", args: { degrees: 120 } },
        { id: "flower-forward-c", type: "forward", args: { distance: 90 } },
        { id: "flower-left-c", type: "turn_left", args: { degrees: 60 } },
        { id: "flower-forward-d", type: "forward", args: { distance: 90 } },
        { id: "flower-right", type: "turn_right", args: { degrees: 100 } },
      ],
    },
  ],
}

export const staircaseProgram: TurtleProgram = {
  version: 1,
  canvas: defaultCanvas,
  start: {
    x: 120,
    y: 380,
    heading: 0,
    pen_down: true,
    stroke_color: "#2563eb",
    stroke_width: 4,
  },
  blocks: [
    {
      id: "stair-repeat",
      type: "repeat",
      args: { times: 6 },
      children: [
        { id: "stair-forward", type: "forward", args: { distance: 55 } },
        { id: "stair-left", type: "turn_left", args: { degrees: 90 } },
        { id: "stair-up", type: "forward", args: { distance: 35 } },
        { id: "stair-right", type: "turn_right", args: { degrees: 90 } },
        { id: "stair-wait", type: "wait", args: { duration_ms: 120 } },
      ],
    },
  ],
}

export const turtlePresets: TurtlePreset[] = [
  {
    id: "square",
    name: "正方形",
    description: "用 repeat 畫出四邊形。",
    program: squareProgram,
  },
  {
    id: "flower",
    name: "花朵",
    description: "重複菱形筆畫形成花瓣。",
    program: flowerProgram,
  },
  {
    id: "staircase",
    name: "階梯",
    description: "前進與轉向組合出的階梯。",
    program: staircaseProgram,
  },
]
