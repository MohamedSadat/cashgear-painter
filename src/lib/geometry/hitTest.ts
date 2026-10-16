import { Bezier } from 'bezier-js'
import type { PathNode, ShapeNode, StrokeNode, TextNode, VectorNode } from '../../types'
import {
  applyTransform,
  arrowHeadSize,
  boxesOverlap,
  canvasSegments,
  isIdentity,
  nodeBounds,
  outlineReach,
  pointsBox,
  textBox,
  type Vec,
} from './bounds'
import { pathSegments, type Cubic } from './pathData'

/** Distance from (px, py) to the segment a–b; a zero-length segment is a point. */
export function distToSegment(px: number, py: number, a: Vec, b: Vec): number {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const lengthSq = dx * dx + dy * dy
  let t = lengthSq === 0 ? 0 : ((px - a[0]) * dx + (py - a[1]) * dy) / lengthSq
  t = Math.max(0, Math.min(1, t))
  return Math.hypot(px - (a[0] + t * dx), py - (a[1] + t * dy))
}

function cross(o: Vec, a: Vec, b: Vec): number {
  return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
}

/** Shortest distance between segments a–b and c–d; 0 when they cross. */
export function segmentsDistance(a: Vec, b: Vec, c: Vec, d: Vec): number {
  const d1 = cross(c, d, a)
  const d2 = cross(c, d, b)
  const d3 = cross(a, b, c)
  const d4 = cross(a, b, d)
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) {
    return 0
  }
  return Math.min(
    distToSegment(a[0], a[1], c, d),
    distToSegment(b[0], b[1], c, d),
    distToSegment(c[0], c[1], a, b),
    distToSegment(d[0], d[1], a, b),
  )
}

/** Whether the point lies inside the polygon (even-odd rule). */
export function pointInPolygon(p: Vec, polygon: ReadonlyArray<Vec>): boolean {
  let inside = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i]
    const b = polygon[j]
    if (
      a[1] > p[1] !== b[1] > p[1] &&
      p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]
    ) {
      inside = !inside
    }
  }
  return inside
}

const canvasPointsCache = new WeakMap<StrokeNode, Vec[]>()

/** A stroke's points in canvas units, after its transform. */
function canvasPoints(node: StrokeNode): ReadonlyArray<Vec> {
  if (isIdentity(node.transform)) return node.points
  let points = canvasPointsCache.get(node)
  if (!points) {
    points = node.points.map(([x, y]) => applyTransform(node.transform, x, y))
    canvasPointsCache.set(node, points)
  }
  return points
}

/** A piece of a shape's outline in canvas units; filled pieces are hit inside too. */
interface Contour {
  points: Vec[]
  closed: boolean
  filled: boolean
}

// Segments per quarter of a rounded corner, and around a whole ellipse.
const ARC_STEPS = 8
const ELLIPSE_STEPS = 64

function roundedRectPoints(width: number, height: number, cornerRadius: number): Vec[] {
  const r = Math.max(0, Math.min(cornerRadius, width / 2, height / 2))
  if (r === 0) {
    return [
      [0, 0],
      [width, 0],
      [width, height],
      [0, height],
    ]
  }
  // Each corner's center and the angle its arc starts at, clockwise from the top right.
  const corners: [number, number, number][] = [
    [width - r, r, -90],
    [width - r, height - r, 0],
    [r, height - r, 90],
    [r, r, 180],
  ]
  const points: Vec[] = []
  for (const [cx, cy, start] of corners) {
    for (let i = 0; i <= ARC_STEPS; i++) {
      const angle = ((start + (90 * i) / ARC_STEPS) * Math.PI) / 180
      points.push([cx + r * Math.cos(angle), cy + r * Math.sin(angle)])
    }
  }
  return points
}

/** The arrowhead at `tip`, pointing away from `from`, as Konva's Arrow draws it. */
function arrowHead(tip: Vec, from: Vec, size: number): Vec[] {
  const angle = Math.atan2(tip[1] - from[1], tip[0] - from[0]) // 0 for a zero-length line
  const ux = Math.cos(angle)
  const uy = Math.sin(angle)
  const bx = tip[0] - ux * size
  const by = tip[1] - uy * size
  const half = size / 2
  return [tip, [bx - uy * half, by + ux * half], [bx + uy * half, by - ux * half]]
}

// A curve is sampled at about this many canvas units per step, within these bounds.
const CURVE_STEP = 4
const MIN_CURVE_STEPS = 2
const MAX_CURVE_STEPS = 64

/** Points along the segments, sampled by bezier-js; the control polygon bounds each one's length. */
function flattenSegments(segments: Cubic[]): Vec[] {
  const points: Vec[] = []
  for (const cubic of segments) {
    let reach = 0
    for (let i = 1; i < 4; i++) {
      reach += Math.hypot(cubic[i][0] - cubic[i - 1][0], cubic[i][1] - cubic[i - 1][1])
    }
    const steps = Math.min(
      MAX_CURVE_STEPS,
      Math.max(MIN_CURVE_STEPS, Math.ceil(reach / CURVE_STEP)),
    )
    const lut = new Bezier(...cubic.flat()).getLUT(steps)
    // Each segment starts where the previous one ended.
    for (let i = points.length === 0 ? 0 : 1; i < lut.length; i++) points.push([lut[i].x, lut[i].y])
  }
  return points
}

/** A shape's outline pieces in its own coordinates. */
function localContours(node: ShapeNode): Contour[] {
  switch (node.type) {
    case 'path': {
      const points = flattenSegments(pathSegments(node.anchors, node.closed))
      // Canvas and SVG fill an open path as if it were closed.
      return points.length < 2
        ? []
        : [{ points, closed: node.closed, filled: node.style.fill !== null }]
    }
    case 'rect':
      return [
        {
          points: roundedRectPoints(node.width, node.height, node.cornerRadius),
          closed: true,
          filled: node.style.fill !== null,
        },
      ]
    case 'ellipse': {
      const points: Vec[] = []
      for (let i = 0; i < ELLIPSE_STEPS; i++) {
        const angle = (i / ELLIPSE_STEPS) * Math.PI * 2
        points.push([node.rx * Math.cos(angle), node.ry * Math.sin(angle)])
      }
      return [{ points, closed: true, filled: node.style.fill !== null }]
    }
    case 'line': {
      const [x1, y1, x2, y2] = node.points
      const start: Vec = [x1, y1]
      const end: Vec = [x2, y2]
      const contours: Contour[] = [{ points: [start, end], closed: false, filled: false }]
      // Arrowheads are filled with the line's color.
      const size = arrowHeadSize(node.style.strokeWidth)
      const filled = node.style.stroke !== null
      if (node.arrowEnd)
        contours.push({ points: arrowHead(end, start, size), closed: true, filled })
      if (node.arrowStart) {
        contours.push({ points: arrowHead(start, end, size), closed: true, filled })
      }
      return contours
    }
  }
}

const contoursCache = new WeakMap<ShapeNode, Contour[]>()

/** A shape's outline pieces in canvas units, after its transform. */
function canvasContours(node: ShapeNode): Contour[] {
  let contours = contoursCache.get(node)
  if (!contours) {
    contours = localContours(node).map((c) => ({
      ...c,
      points: c.points.map((p) => applyTransform(node.transform, p[0], p[1])),
    }))
    contoursCache.set(node, contours)
  }
  return contours
}

/** Shortest distance from the segment a–b to the contour's edges. */
function contourDistance({ points, closed }: Contour, a: Vec, b: Vec): number {
  let best = Infinity
  const count = closed ? points.length : points.length - 1
  for (let i = 0; i < count; i++) {
    best = Math.min(best, segmentsDistance(points[i], points[(i + 1) % points.length], a, b))
    if (best === 0) break
  }
  return best
}

const isShape = (node: VectorNode): node is ShapeNode =>
  node.type === 'rect' || node.type === 'ellipse' || node.type === 'line' || node.type === 'path'

/** A text's box in canvas units, after its transform: Konva picks text anywhere in its box. */
function textContour(node: TextNode): Contour {
  const box = textBox(node)
  const corners: Vec[] = [
    [box.minX, box.minY],
    [box.maxX, box.minY],
    [box.maxX, box.maxY],
    [box.minX, box.maxY],
  ]
  return {
    points: corners.map((p) => applyTransform(node.transform, p[0], p[1])),
    closed: true,
    filled: true,
  }
}

/**
 * Whether a circle of `radius` swept from a to b touches the node's ink. Testing the swept segment,
 * not just its ends, keeps a fast swipe from skipping strokes between two pointer samples. An
 * unfilled shape is touched only on its outline, as it is picked on the canvas; a text anywhere
 * in its box. Groups are never touched themselves, only what they hold, in canvas units.
 */
export function nodeHitsSegment(node: VectorNode, a: Vec, b: Vec, radius: number): boolean {
  if (node.type === 'group') return false
  const bounds = nodeBounds(node)
  if (!bounds || !boxesOverlap(bounds, pointsBox([a, b], radius))) return false
  // Outlines scale with their node, so the ink's half-width does too.
  const { scaleX, scaleY } = node.transform
  const scale = (Math.abs(scaleX) + Math.abs(scaleY)) / 2

  if (node.type === 'stroke') {
    const reach = radius + (node.size / 2) * scale
    const points = canvasPoints(node)
    if (points.length === 1) return distToSegment(points[0][0], points[0][1], a, b) <= reach
    for (let i = 1; i < points.length; i++) {
      if (segmentsDistance(points[i - 1], points[i], a, b) <= reach) return true
    }
    return false
  }

  if (node.type === 'text') {
    const contour = textContour(node)
    return contourDistance(contour, a, b) <= radius || pointInPolygon(a, contour.points)
  }

  if (!isShape(node)) return false
  const reach = radius + outlineReach(node) * scale
  return canvasContours(node).some(
    (contour) =>
      contourDistance(contour, a, b) <= reach ||
      (contour.filled && pointInPolygon(a, contour.points)),
  )
}

export interface PathPoint {
  segment: number // index of the segment, which starts at the anchor of the same index
  t: number // 0..1 along it
  distance: number // canvas units from the point asked about
}

/** The point of a path's outline nearest a canvas point, found by bezier-js; null without segments. */
export function nearestOnPath(node: PathNode, { 0: x, 1: y }: Vec): PathPoint | null {
  let best: PathPoint | null = null
  const segments = canvasSegments(node)
  for (let segment = 0; segment < segments.length; segment++) {
    const p = new Bezier(...segments[segment].flat()).project({ x, y })
    const distance = Math.hypot(p.x - x, p.y - y)
    if (!best || distance < best.distance) best = { segment, t: p.t, distance }
  }
  return best
}
