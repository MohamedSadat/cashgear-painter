export type NodeId = string
export type Point = [x: number, y: number, pressure: number]

export interface Transform {
  x: number
  y: number
  rotation: number // degrees
  scaleX: number
  scaleY: number
}

export type AssetId = string // SHA-256 hex of the image bytes
export type FillRule = 'nonzero' | 'evenodd'

export interface Stop {
  offset: number // 0..1
  color: string
  opacity: number
}

/** How a fill is painted. Gradient points are in units of the node's box (0..1). */
export type Paint =
  | { kind: 'solid'; color: string }
  | { kind: 'linear'; stops: Stop[]; start: [number, number]; end: [number, number] }
  // radius in units of the box's longer side
  | { kind: 'radial'; stops: Stop[]; center: [number, number]; radius: number }

export interface Style {
  fill: Paint | null // null = no fill
  stroke: string | null // hex; stays solid in v3
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

/** One subpath of a path: its anchors, and whether it closes back to the first. */
export interface Contour {
  anchors: Anchor[]
  closed: boolean
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
  | (BaseNode & { type: 'path'; contours: Contour[]; fillRule: FillRule })
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
  | (BaseNode & {
      type: 'image'
      assetId: AssetId
      width: number // local units the shown part fills: 0..width × 0..height
      height: number
      crop: CropRect | null // the part of the image shown, in its pixels; null = all of it
    })

/** A rectangle of an image, in the image's own pixels. */
export interface CropRect {
  x: number
  y: number
  width: number
  height: number
}

export type NodeType = VectorNode['type']
export type NodeOf<T extends NodeType> = Extract<VectorNode, { type: T }>
export type StrokeNode = NodeOf<'stroke'>
export type PathNode = NodeOf<'path'>
export type TextNode = NodeOf<'text'>
export type GroupNode = NodeOf<'group'>
export type ImageNode = NodeOf<'image'>
/** Nodes drawn as geometry with an optional outline: rectangles, ellipses, lines and paths. */
export type ShapeNode = NodeOf<'rect' | 'ellipse' | 'line' | 'path'>

/** A new drawing's page, in CSS pixels at 96 dpi: v1 and v2's fixed artboard. */
export const DEFAULT_PAGE_WIDTH = 1600
export const DEFAULT_PAGE_HEIGHT = 1000
// A new drawing's first page and a migrated v2 drawing's only page share this id.
export const FIRST_PAGE_ID = 'page-1'

export interface Page {
  id: string
  name: string
  width: number // px at 96 dpi
  height: number
  background: Paint
  rootIds: NodeId[] // z-order, bottom to top; groups order their own childIds
}

export type ImageMime = 'image/png' | 'image/jpeg' | 'image/webp'

export interface AssetMeta {
  id: AssetId
  mime: ImageMime
  width: number
  height: number
  bytes: number
}

export interface Doc {
  version: 3
  pages: Page[]
  nodes: Record<NodeId, VectorNode> // every node of every page
  assets: Record<AssetId, AssetMeta> // blobs live in IndexedDB, not here
}

export type ToolId =
  'select' | 'direct' | 'brush' | 'eraser' | 'rect' | 'ellipse' | 'line' | 'pen' | 'text' | 'hand'

export const IDENTITY_TRANSFORM: Transform = { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 }

/** An empty page with a white background. */
export function newPage(
  id: string,
  name: string,
  width = DEFAULT_PAGE_WIDTH,
  height = DEFAULT_PAGE_HEIGHT,
): Page {
  return { id, name, width, height, background: { kind: 'solid', color: '#ffffff' }, rootIds: [] }
}

export function emptyDoc(): Doc {
  return { version: 3, pages: [newPage(FIRST_PAGE_ID, 'Page 1')], nodes: {}, assets: {} }
}
