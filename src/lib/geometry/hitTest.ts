import type { StrokeNode, VectorNode } from '../../types'
import { applyTransform, boxesOverlap, isIdentity, nodeBounds, pointsBox, type Vec } from './bounds'

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

/**
 * Whether a circle of `radius` swept from a to b touches the node's ink. Testing the swept segment,
 * not just its ends, keeps a fast swipe from skipping strokes between two pointer samples.
 */
export function nodeHitsSegment(node: VectorNode, a: Vec, b: Vec, radius: number): boolean {
  if (node.type !== 'stroke') return false
  const bounds = nodeBounds(node)
  if (!bounds || !boxesOverlap(bounds, pointsBox([a, b], radius))) return false

  const { scaleX, scaleY } = node.transform
  const reach = radius + (node.size / 2) * ((Math.abs(scaleX) + Math.abs(scaleY)) / 2)
  const points = canvasPoints(node)
  if (points.length === 1) return distToSegment(points[0][0], points[0][1], a, b) <= reach
  for (let i = 1; i < points.length; i++) {
    if (segmentsDistance(points[i - 1], points[i], a, b) <= reach) return true
  }
  return false
}
