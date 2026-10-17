import paper from 'paper/dist/paper-core'
import { fillBox } from '../geometry/bounds'
import {
  arrival,
  cachedPathData,
  contoursData,
  departure,
  pathData,
  pathSegments,
  shapeAnchors,
  withKinds,
  type Xy,
} from '../geometry/pathData'
import {
  absoluteTransform,
  affineOf,
  applyAffine,
  composeTransform,
  invertAffine,
  multiplyAffine,
  parentTransform,
  type Affine,
} from '../geometry/transform'
import { isGradient, mapGradient } from '../paint/paint'
import { cachedStrokePath } from '../strokePath'
import { DEFAULT_SHAPE_STYLE } from '../../store/editorStore'
import type { Anchor, Contour, NodeId, PathNode, Style, VectorNode } from '../../types'

// This module is loaded with a dynamic import() on first use (editorStore's booleanOp), so Paper
// never weighs on startup.

/**
 * What a boolean operation keeps: everything any shape covers, the bottom shape without what lies
 * above it, only what all shapes share, or what an odd number of them cover.
 */
export type BooleanKind = 'union' | 'subtract' | 'intersect' | 'exclude'

// Headless: one 1 × 1 project that nothing is drawn into. New items stay out of it, so nothing
// piles up there from one operation to the next.
paper.setup(new paper.Size(1, 1))
paper.settings.insertItems = false

type Item = paper.PathItem
type Nodes = Readonly<Record<NodeId, VectorNode>>

const OPERATIONS = {
  union: 'unite',
  subtract: 'subtract',
  intersect: 'intersect',
  exclude: 'exclude',
} as const

// Names new shapes and strokes get; a result named so is called Path, as Convert to path does.
const DEFAULT_NAMES = new Set(['Rectangle', 'Ellipse', 'Line', 'Stroke'])
// Subpaths of a result enclosing less than this (in square canvas units) are float noise.
const MIN_AREA = 1e-3
// Paper's simplify tolerance, in canvas units, and the spacing it samples a contour at first.
const SIMPLIFY_TOLERANCE = 2.5
const SIMPLIFY_SPACING = 2
// A fit must drop at least this share of a contour's anchors, and this many. Each fit can stray
// up to the tolerance, so a second Simplify, which would trim only a few more, doesn't wear the
// shape down, and a circle's 4 anchors don't become a lumpier 3.
const MIN_SAVING = 0.25
const MIN_DROPPED = 4
// A turn sharper than this (in radians) is a corner, which Simplify keeps.
const CORNER_TURN = (25 * Math.PI) / 180
// A segment whose control points lie this close to its chord (in canvas units) runs straight.
const STRAIGHT = 0.01

const round3 = (n: number) => Math.round(n * 1000) / 1000 || 0

/**
 * A node's outline as SVG path data in its own coordinates: rectangles, ellipses and lines as
 * Convert to path makes them, paths with their contours, and freehand strokes as the outline
 * perfect-freehand draws. Null when it draws nothing.
 */
function outlineData(node: VectorNode): string | null {
  switch (node.type) {
    case 'rect':
    case 'ellipse':
    case 'line':
      return contoursData([shapeAnchors(node)])
    case 'path':
      return cachedPathData(node) || null
    case 'stroke':
      return node.points.length > 0 ? cachedStrokePath(node) || null : null
    default:
      return null
  }
}

const toMatrix = ([a, b, c, d, e, f]: Affine) => new paper.Matrix(a, b, c, d, e, f)

/** The item's subpaths: a compound path's children, or the path itself. */
function pathsOf(item: Item): paper.Path[] {
  return item instanceof paper.CompoundPath ? (item.children as paper.Path[]) : [item as paper.Path]
}

/**
 * The node as a Paper item on the canvas: its outline through its transform and every group it
 * is in. Open subpaths close with a straight line, as a fill closes them. Crossings are resolved
 * and subpaths oriented by the node's fill rule, so a freehand outline that crosses itself, as
 * most do at sharp turns, doesn't break the operation. Null when it draws nothing.
 */
export function toPaperItem(nodes: Nodes, id: NodeId): Item | null {
  const node = nodes[id]
  const d = node ? outlineData(node) : null
  if (!d) return null
  const nonzero = node.type !== 'path' || node.fillRule === 'nonzero'
  const item: Item = paper.PathItem.create(d)
  item.fillRule = nonzero ? 'nonzero' : 'evenodd'
  for (const path of pathsOf(item)) path.closed = true
  item.transform(toMatrix(affineOf(absoluteTransform(nodes, id))))
  // Not in Paper 0.12's typings, though it is part of its API.
  const resolved = (item as Item & { resolveCrossings(): Item }).resolveCrossings()
  return resolved.reorient(nonzero, true)
}

/** The items folded together in order with the operation; the first is the bottom-most. */
function fold(items: Item[], kind: BooleanKind): Item {
  const op = OPERATIONS[kind]
  return items.slice(1).reduce((acc, item) => acc[op](item, { insert: false }), items[0])
}

type MapXy = (x: number, y: number) => Xy
const unmapped: MapXy = (x, y) => [x, y]

/**
 * Paper's segments as corner anchors, each point taken through `map`: segment points become
 * anchors, and their handles the anchors' handles. Coordinates are rounded to thousandths.
 */
function anchorsOf(segments: paper.Segment[], map: MapXy): Anchor[] {
  return segments.map(({ point, handleIn, handleOut }): Anchor => {
    const [x, y] = map(point.x, point.y)
    const [ix, iy] = map(point.x + handleIn.x, point.y + handleIn.y)
    const [ox, oy] = map(point.x + handleOut.x, point.y + handleOut.y)
    const numbers = [x, y, ix - x, iy - y, ox - x, oy - y]
    if (!numbers.every(Number.isFinite)) throw new Error('Paper gave a point that is not a number.')
    const [ax, ay, inX, inY, outX, outY] = numbers.map(round3)
    return { x: ax, y: ay, inX, inY, outX, outY, kind: 'corner' }
  })
}

/**
 * The item's subpaths as contours, each point taken through `map`, with anchor kinds that follow
 * the curve. Subpaths of fewer than 2 anchors, or closed ones with no area, are left out.
 */
function contoursOfItem(item: Item, map: MapXy): Contour[] {
  return pathsOf(item).flatMap((path): Contour[] => {
    if (path.closed && Math.abs(path.area) < MIN_AREA) return []
    const anchors = anchorsOf(path.segments, map)
    if (anchors.length < 2) return []
    return [{ anchors: withKinds(anchors, path.closed), closed: path.closed }]
  })
}

/**
 * `style` with a gradient fill laid out again for its new node, so it stays where it was on the
 * canvas: `map` takes the old node's coordinates to the new one's.
 */
function keepGradient(style: Style, from: VectorNode, to: PathNode, map: Affine): Style {
  const { fill } = style
  if (!isGradient(fill)) return style
  const fromBox = fillBox(from)
  const toBox = fillBox(to)
  if (!fromBox || !toBox) return style
  return { ...style, fill: mapGradient(fill, fromBox, toBox, map) }
}

/**
 * A boolean operation on the nodes, given bottom to top: rectangles, ellipses, lines, paths and
 * freehand strokes, each in page coordinates with its transform applied. Union, subtract,
 * intersect and exclude fold across them in that order, so subtract takes every shape above it
 * from the bottom-most one. The result is one path node that takes the bottom-most node's place:
 * its id, group, position and turn, and its style, a gradient fill staying where it was on the
 * canvas. Each subpath of the result is a contour, holes included. Null when nothing is left,
 * as when shapes that don't overlap are intersected. Paper's errors are thrown.
 */
export function combine(nodes: Nodes, ids: readonly NodeId[], kind: BooleanKind): PathNode | null {
  const bottom = nodes[ids[0]]
  if (!bottom || ids.length < 2) return null
  const items = ids.map((id) => toPaperItem(nodes, id))
  // A shape that draws nothing leaves nothing to subtract from, or to share.
  if ((kind === 'subtract' && items[0] === null) || (kind === 'intersect' && items.includes(null)))
    return null
  const drawn = items.filter((item) => item !== null)
  if (drawn.length === 0) return null
  const result = fold(drawn, kind)

  // The result keeps the bottom node's position and turn; paths bake their scale.
  const transform = { ...bottom.transform, scaleX: 1, scaleY: 1 }
  const frame = affineOf(composeTransform(parentTransform(nodes, bottom.id), transform))
  const toLocal = invertAffine(frame)
  if (!toLocal) return null
  const contours = contoursOfItem(result, (x, y) => applyAffine(toLocal, x, y))
  if (contours.length === 0) return null

  // A freehand stroke has no outline width; the result's starts as a new shape's would.
  const style =
    bottom.type === 'stroke'
      ? { ...bottom.style, strokeWidth: DEFAULT_SHAPE_STYLE.strokeWidth }
      : bottom.style
  const path: PathNode = {
    id: bottom.id,
    name: DEFAULT_NAMES.has(bottom.name) ? 'Path' : bottom.name,
    parentId: bottom.parentId,
    transform,
    style,
    hidden: false,
    locked: false,
    type: 'path',
    contours,
    // Paper orients holes against the shapes around them, so either rule fills the same.
    fillRule: 'nonzero',
  }
  const map = multiplyAffine(toLocal, affineOf(absoluteTransform(nodes, bottom.id)))
  return { ...path, style: keepGradient(style, bottom, path, map) }
}

/**
 * The anchors where a contour turns by more than CORNER_TURN, which a fit keeps sharp, by index;
 * an open contour's ends count.
 */
function cornersOf({ anchors, closed }: Contour): number[] {
  const segments = pathSegments(anchors, closed)
  const n = anchors.length
  const corners: number[] = []
  for (let i = 0; i < n; i++) {
    const before = closed || i > 0 ? segments[(i - 1 + n) % n] : undefined
    const after = closed || i < n - 1 ? segments[i] : undefined
    if (!before || !after) {
      corners.push(i)
      continue
    }
    const u = arrival(before)
    const v = departure(after)
    const cos = (u[0] * v[0] + u[1] * v[1]) / (Math.hypot(...u) * Math.hypot(...v))
    if (!(cos > Math.cos(CORNER_TURN))) corners.push(i)
  }
  return corners
}

/**
 * Paper's simplify through points sampled along the anchors' curves at most SIMPLIFY_SPACING
 * apart, so the fit follows long curves and straight sides too: Paper fits through points alone.
 * An open run keeps its ends.
 */
function fit(anchors: Anchor[], closed: boolean): Anchor[] | null {
  const source = paper.PathItem.create(pathData(anchors, closed)) as paper.Path
  const points: paper.Point[] = []
  for (const curve of source.curves) {
    const steps = Math.max(1, Math.ceil(curve.length / SIMPLIFY_SPACING))
    for (let i = 0; i < steps; i++) points.push(curve.getPointAtTime(i / steps))
  }
  if (!closed && source.lastSegment) points.push(source.lastSegment.point)
  const path = new paper.Path({ segments: points, closed })
  return path.simplify(SIMPLIFY_TOLERANCE) ? anchorsOf(path.segments, unmapped) : null
}

/** The anchors without handles on segments that run straight, as a straight side has none. */
function straighten(anchors: Anchor[], closed: boolean): Anchor[] {
  const out = anchors.map((a) => ({ ...a }))
  pathSegments(anchors, closed).forEach(([p0, c1, c2, p3], i) => {
    const dx = p3[0] - p0[0]
    const dy = p3[1] - p0[1]
    const length = Math.hypot(dx, dy)
    if (length === 0) return
    // A control point on the chord: close to its line, and between its ends.
    const onChord = ([x, y]: Xy) => {
      const off = Math.abs(dx * (y - p0[1]) - dy * (x - p0[0])) / length
      const along = ((x - p0[0]) * dx + (y - p0[1]) * dy) / (length * length)
      return off <= STRAIGHT && along >= 0 && along <= 1
    }
    if (!onChord(c1) || !onChord(c2)) return
    const a = out[i]
    const b = out[(i + 1) % out.length]
    a.outX = a.outY = 0
    b.inX = b.inY = 0
  })
  return out
}

/**
 * The contour fitted by Paper's simplify(2.5), within 2.5 canvas units of its shape. Its corners
 * stay where they are, and sharp: the runs between them are fitted one by one, so a straight side
 * stays one straight segment and only curves get new anchors. Null when a fit fails.
 */
function simplifyContour(contour: Contour): Contour | null {
  const { anchors, closed } = contour
  const corners = cornersOf(contour)
  if (closed && corners.length === 0) {
    const loop = fit(anchors, true)
    return loop && { anchors: withKinds(straighten(loop, true), true), closed }
  }
  const n = anchors.length
  // Closed: from each corner round to the next, the last back to the first.
  const ends = closed ? [...corners, corners[0] + n] : corners
  const fitted: Anchor[] = []
  for (let k = 0; k + 1 < ends.length; k++) {
    const run: Anchor[] = []
    for (let i = ends[k]; i <= ends[k + 1]; i++) run.push(anchors[i % n])
    const part = fit(run, false)
    if (!part) return null
    // Runs meet at a corner: the run before gives it its in handle, the run after its out.
    const joint = fitted.pop()
    if (joint) part[0] = { ...part[0], inX: joint.inX, inY: joint.inY }
    fitted.push(...part)
  }
  if (closed) {
    const last = fitted.pop()!
    fitted[0] = { ...fitted[0], inX: last.inX, inY: last.inY }
  }
  return { anchors: withKinds(straighten(fitted, closed), closed), closed }
}

/**
 * The path with each contour simplified by Paper's simplify(2.5), corners kept: a fit within 2.5
 * canvas units of its shape, with far fewer anchors where a boolean result of a freehand stroke
 * has hundreds. A contour keeps its anchors unless the fit drops at least a quarter of them, and
 * at least 4, so a rectangle or a circle stays as it is, and so does a path simplified once
 * already. A gradient fill stays
 * where it was. Null when no contour changes.
 */
export function simplifyPath(node: PathNode): PathNode | null {
  let changed = false
  const contours = node.contours.map((contour) => {
    if (contour.anchors.length < 3) return contour
    const simpler = simplifyContour(contour)
    const dropped = simpler ? contour.anchors.length - simpler.anchors.length : 0
    if (!simpler || dropped < MIN_DROPPED || dropped < contour.anchors.length * MIN_SAVING) {
      return contour
    }
    changed = true
    return simpler
  })
  if (!changed) return null
  const path: PathNode = { ...node, contours }
  return { ...path, style: keepGradient(node.style, node, path, [1, 0, 0, 1, 0, 0]) }
}
