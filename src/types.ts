export type Tool = 'brush' | 'eraser'
export type Point = [x: number, y: number, pressure: number]

export interface Stroke {
  id: string
  tool: Tool
  color: string // hex; ignored for eraser
  size: number // in canvas units
  usesPressure: boolean // true only when drawn with a pen
  points: Point[]
}

/** The drawing surface in logical canvas units; the Stage is scaled to fit its container. */
export const CANVAS_WIDTH = 1600
export const CANVAS_HEIGHT = 1000
