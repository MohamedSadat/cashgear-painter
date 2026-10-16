export type NodeId = string
export type Point = [x: number, y: number, pressure: number]

export interface Transform {
  x: number
  y: number
  rotation: number // degrees
  scaleX: number
  scaleY: number
}

export interface Style {
  fill: string | null // hex; null = no fill
  stroke: string | null
  strokeWidth: number // canvas units, never scaled by transforms
  opacity: number // 0..1
}

export interface BaseNode {
  id: NodeId
  name: string
  parentId: NodeId | null // null = top level
  transform: Transform
  style: Style
  hidden: boolean
  locked: boolean
}

export interface Anchor {
  x: number // local coordinates
  y: number
  inX: number // handle toward the previous anchor, relative to x/y
  inY: number
  outX: number // handle toward the next anchor, relative to x/y
  outY: number
  kind: 'corner' | 'smooth' | 'symmetric'
}

export type VectorNode =
  | (BaseNode & { type: 'stroke'; points: Point[]; size: number; usesPressure: boolean })
  | (BaseNode & { type: 'rect'; width: number; height: number; cornerRadius: number })
  | (BaseNode & { type: 'ellipse'; rx: number; ry: number })
  | (BaseNode & {
      type: 'line'
      points: [number, number, number, number]
      arrowStart: boolean
      arrowEnd: boolean
    })
  | (BaseNode & { type: 'path'; anchors: Anchor[]; closed: boolean })
  | (BaseNode & {
      type: 'text'
      text: string
      fontFamily: string
      fontSize: number
      fontStyle: 'normal' | 'bold' | 'italic' | 'bold italic'
      align: 'left' | 'center' | 'right'
      width: number
    })
  | (BaseNode & { type: 'group'; childIds: NodeId[] })

export type NodeType = VectorNode['type']
export type NodeOf<T extends NodeType> = Extract<VectorNode, { type: T }>
export type StrokeNode = NodeOf<'stroke'>
export type PathNode = NodeOf<'path'>
export type TextNode = NodeOf<'text'>
export type GroupNode = NodeOf<'group'>
/** Nodes drawn as geometry with an optional outline: rectangles, ellipses, lines and paths. */
export type ShapeNode = NodeOf<'rect' | 'ellipse' | 'line' | 'path'>

/** The drawing surface in logical canvas units; the Stage is scaled to fit its container. */
export const CANVAS_WIDTH = 1600
export const CANVAS_HEIGHT = 1000

export interface Doc {
  version: 2
  width: typeof CANVAS_WIDTH // the artboard, as in v1
  height: typeof CANVAS_HEIGHT
  background: string // '#ffffff'
  nodes: Record<NodeId, VectorNode>
  rootIds: NodeId[] // z-order, bottom to top; groups order their own childIds
}

export type ToolId =
  'select' | 'direct' | 'brush' | 'eraser' | 'rect' | 'ellipse' | 'line' | 'pen' | 'text' | 'hand'

export const IDENTITY_TRANSFORM: Transform = { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 }

export function emptyDoc(): Doc {
  return {
    version: 2,
    width: CANVAS_WIDTH,
    height: CANVAS_HEIGHT,
    background: '#ffffff',
    nodes: {},
    rootIds: [],
  }
}
