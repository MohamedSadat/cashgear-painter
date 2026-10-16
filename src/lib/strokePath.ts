import { getStroke } from 'perfect-freehand'
import type { Point, StrokeNode } from '../types'

const average = (a: number, b: number) => (a + b) / 2

/** Turns a perfect-freehand outline into a closed SVG path of quadratic curves. */
export function getSvgPathFromStroke(outline: number[][]): string {
  const len = outline.length
  if (len < 4) return ''

  let a = outline[0]
  let b = outline[1]
  const c = outline[2]
  let result = `M${a[0].toFixed(2)},${a[1].toFixed(2)} Q${b[0].toFixed(2)},${b[1].toFixed(2)} ${average(b[0], c[0]).toFixed(2)},${average(b[1], c[1]).toFixed(2)} T`

  for (let i = 2, max = len - 1; i < max; i++) {
    a = outline[i]
    b = outline[i + 1]
    result += `${average(a[0], b[0]).toFixed(2)},${average(a[1], b[1]).toFixed(2)} `
  }

  return `${result}Z`
}

type StrokeShape = Pick<StrokeNode, 'points' | 'size' | 'usesPressure'>

/** perfect-freehand's outline polygon for a stroke. */
function strokeOutline(stroke: StrokeShape, last: boolean): number[][] {
  return getStroke(stroke.points, {
    size: stroke.size,
    thinning: 0.5,
    smoothing: 0.5,
    streamline: 0.5,
    simulatePressure: !stroke.usesPressure,
    last,
  })
}

/** SVG path data for a stroke's filled outline. `last` is false while the stroke is still being drawn. */
export function strokeToPath(stroke: StrokeShape, last = true): string {
  if (stroke.points.length === 0) return ''
  return getSvgPathFromStroke(strokeOutline(stroke, last))
}

export interface OutlineBox {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

const outlineBoxCache = new WeakMap<
  Point[],
  { size: number; usesPressure: boolean; box: OutlineBox | null }
>()

/**
 * The box around a finished stroke's outline in its own coordinates, where its ink shows; null
 * for a stroke without points. The path's curves stay inside the outline polygon, so this is
 * the ink's box or a hair more. Cached by the points array, as the outline is.
 */
export function strokeOutlineBox(stroke: StrokeShape): OutlineBox | null {
  const cached = outlineBoxCache.get(stroke.points)
  if (cached && cached.size === stroke.size && cached.usesPressure === stroke.usesPressure) {
    return cached.box
  }
  let box: OutlineBox | null = null
  if (stroke.points.length > 0) {
    box = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity }
    for (const [x, y] of strokeOutline(stroke, true)) {
      box.minX = Math.min(box.minX, x)
      box.minY = Math.min(box.minY, y)
      box.maxX = Math.max(box.maxX, x)
      box.maxY = Math.max(box.maxY, y)
    }
    if (!Number.isFinite(box.minX)) box = null
  }
  outlineBoxCache.set(stroke.points, {
    size: stroke.size,
    usesPressure: stroke.usesPressure,
    box,
  })
  return box
}

// Keyed by the points array: immer keeps it as the same object while a stroke is moved, rotated
// or restyled, so its outline is computed once, even across undo and redo.
const pathCache = new WeakMap<Point[], { size: number; usesPressure: boolean; data: string }>()

/** A finished stroke's outline data, from the cache when its points haven't changed. */
export function cachedStrokePath(node: StrokeShape): string {
  const cached = pathCache.get(node.points)
  if (cached && cached.size === node.size && cached.usesPressure === node.usesPressure) {
    return cached.data
  }
  const data = strokeToPath(node)
  pathCache.set(node.points, { size: node.size, usesPressure: node.usesPressure, data })
  return data
}
