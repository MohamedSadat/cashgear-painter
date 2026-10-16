import type { Point, Transform } from '../../types'
import {
  applyTransform,
  boxesOverlap,
  invertTransform,
  isIdentity,
  pointsBox,
  type Box,
} from './bounds'
import { distToSegment } from './hitTest'

export interface EraserPath {
  points: Point[]
  size: number
}

interface Segment {
  a: Point
  b: Point
  box: Box
}

const BISECT_STEPS = 12

function lerp(a: Point, b: Point, t: number): Point {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
}

/**
 * Removes the parts of a freehand stroke that an eraser path covers, and returns the runs of points
 * that are left. A point is erased when it lies within eraser radius + brush radius of the eraser
 * path, so the gap left behind is about as wide as the eraser even on thick strokes.
 *
 * Original points are kept as they are; only boundary points where a run meets the eraser are
 * added. When nothing is erased the result is `[points]`, the same array. Split runs with fewer
 * than 2 points are dropped.
 */
export function eraseSplit(points: Point[], brushSize: number, eraser: EraserPath): Point[][] {
  if (points.length === 0 || eraser.points.length === 0) return [points]
  const reach = eraser.size / 2 + brushSize / 2
  const step = Math.max(0.5, reach / 4)

  const eraserPoints = eraser.points
  if (!boxesOverlap(pointsBox(points), pointsBox(eraserPoints, reach))) return [points]

  const segments: Segment[] = []
  for (let i = 0; i < Math.max(1, eraserPoints.length - 1); i++) {
    const a = eraserPoints[i]
    const b = eraserPoints[Math.min(i + 1, eraserPoints.length - 1)]
    segments.push({ a, b, box: pointsBox([a, b], reach) })
  }

  const coveredBy = (p: Point, near: Segment[]) =>
    near.some((s) => distToSegment(p[0], p[1], s.a, s.b) <= reach)

  /** The last uncovered position between an uncovered point and a covered one, by bisection. */
  const boundary = (outside: Point, inside: Point, near: Segment[]): Point => {
    let lo = 0
    let hi = 1
    for (let i = 0; i < BISECT_STEPS; i++) {
      const mid = (lo + hi) / 2
      if (coveredBy(lerp(outside, inside, mid), near)) hi = mid
      else lo = mid
    }
    return lerp(outside, inside, lo)
  }

  const runs: Point[][] = []
  let run: Point[] = []
  let erased = false

  let prev = points[0]
  let prevCovered = coveredBy(prev, segments)
  if (prevCovered) erased = true
  else run.push(prev)

  for (let i = 1; i < points.length; i++) {
    const next = points[i]
    // Only eraser segments near this brush segment can cover any part of it.
    const segmentBox = pointsBox([prev, next])
    const near = segments.filter((s) => boxesOverlap(s.box, segmentBox))

    // prev can't be covered here either: a covered point sits inside a nearby segment's box.
    if (near.length === 0) {
      run.push(next)
      prev = next
      continue
    }

    const length = Math.hypot(next[0] - prev[0], next[1] - prev[1])
    const samples = Math.max(1, Math.ceil(length / step))
    let last = prev
    for (let k = 1; k <= samples; k++) {
      const sample = k === samples ? next : lerp(prev, next, k / samples)
      const covered = coveredBy(sample, near)
      if (covered && !prevCovered) {
        run.push(boundary(last, sample, near))
        runs.push(run)
        run = []
        erased = true
      } else if (!covered && prevCovered) {
        run = [boundary(sample, last, near)]
      }
      prevCovered = covered
      last = sample
    }
    if (!prevCovered) run.push(next)
    prev = next
  }

  if (!erased) return [points]
  if (!prevCovered) runs.push(run)
  return runs.filter((r) => r.length >= 2)
}

/**
 * eraseSplit for a stroke that `transform` places on the canvas, with the eraser path in canvas
 * units. The cut is made on the canvas, so the gap is as wide as the eraser on a scaled stroke
 * too, and the runs come back in the stroke's own coordinates. The ink's half-width scales by the
 * mean of the two axes' scales, as the eraser's hit test assumes. Kept points are the stroke's
 * own; when nothing is erased the result is `[points]`, the same array.
 */
export function eraseSplitPlaced(
  points: Point[],
  brushSize: number,
  transform: Transform,
  eraser: EraserPath,
): Point[][] {
  if (isIdentity(transform)) return eraseSplit(points, brushSize, eraser)
  const own = new Map<Point, Point>()
  const placed = points.map((p) => {
    const q: Point = [...applyTransform(transform, p[0], p[1]), p[2]]
    own.set(q, p)
    return q
  })
  const scale = (Math.abs(transform.scaleX) + Math.abs(transform.scaleY)) / 2
  const runs = eraseSplit(placed, brushSize * scale, eraser)
  if (runs.length === 1 && runs[0] === placed) return [points]
  return runs.map((run) =>
    run.map((q) => own.get(q) ?? [...invertTransform(transform, q[0], q[1]), q[2]]),
  )
}
