import { Bezier } from 'bezier-js'
import type { Anchor, NodeOf, PathNode } from '../../types'

export type Xy = [number, number]
/** A cubic Bézier segment: its start, the start's out handle, the end's in handle, its end. */
export type Cubic = [Xy, Xy, Xy, Xy]
export type HandleSide = 'in' | 'out'
export type AnchorKind = Anchor['kind']

/** Handle length of a quarter circle, as a fraction of its radius. */
export const KAPPA = 0.5523

/** Maps a local point to another space, such as the canvas through a node's transform. */
type MapXy = (x: number, y: number) => Xy
const identity: MapXy = (x, y) => [x, y]

/** -n without -0, which would make equal anchors compare unequal. */
const neg = (n: number) => (n === 0 ? 0 : -n)

/**
 * The cubic segments between consecutive anchors, plus one from the last back to the first when
 * the path is closed. None for fewer than 2 anchors.
 */
export function pathSegments(
  anchors: readonly Anchor[],
  closed: boolean,
  map: MapXy = identity,
): Cubic[] {
  const n = anchors.length
  if (n < 2) return []
  const segments: Cubic[] = []
  for (let i = 0; i < (closed ? n : n - 1); i++) {
    const a = anchors[i]
    const b = anchors[(i + 1) % n]
    segments.push([
      map(a.x, a.y),
      map(a.x + a.outX, a.y + a.outY),
      map(b.x + b.inX, b.y + b.inY),
      map(b.x, b.y),
    ])
  }
  return segments
}

// Thousandths of a unit stay far below a screen pixel even at 32× zoom.
function num(n: number): string {
  const rounded = Math.round(n * 1000) / 1000
  return rounded === 0 ? '0' : String(rounded)
}

/**
 * SVG path data for the anchors: M at the first anchor, then C prev.out, cur.in, cur for each
 * segment, and a closing segment back to the first anchor plus Z when the path is closed.
 */
export function pathData(anchors: readonly Anchor[], closed: boolean): string {
  if (anchors.length === 0) return ''
  const parts = [`M ${num(anchors[0].x)} ${num(anchors[0].y)}`]
  for (const [, c1, c2, end] of pathSegments(anchors, closed)) {
    parts.push(`C ${[c1, c2, end].map(([x, y]) => `${num(x)} ${num(y)}`).join(' ')}`)
  }
  if (closed) parts.push('Z')
  return parts.join(' ')
}

// Keyed by the anchors array: immer keeps it as the same object while a path is moved, turned or
// restyled, so its data is built once, even across undo and redo.
const dataCache = new WeakMap<readonly Anchor[], { closed: boolean; data: string }>()

/** A path node's data, from the cache when its anchors haven't changed. */
export function cachedPathData({ anchors, closed }: Pick<PathNode, 'anchors' | 'closed'>): string {
  const cached = dataCache.get(anchors)
  if (cached?.closed === closed) return cached.data
  const data = pathData(anchors, closed)
  dataCache.set(anchors, { closed, data })
  return data
}

export function handleOf(anchor: Anchor, side: HandleSide): Xy {
  return side === 'in' ? [anchor.inX, anchor.inY] : [anchor.outX, anchor.outY]
}

const hasHandle = (anchor: Anchor, side: HandleSide) => {
  const [x, y] = handleOf(anchor, side)
  return x !== 0 || y !== 0
}

function setHandle(anchor: Anchor, side: HandleSide, [x, y]: Xy): Anchor {
  return side === 'in' ? { ...anchor, inX: x, inY: y } : { ...anchor, outX: x, outY: y }
}

/**
 * The anchor with one handle moved to `to`, relative to the anchor. The other handle follows the
 * anchor's kind: a smooth anchor keeps it in line, a symmetric one also keeps it as long, and a
 * corner leaves it alone. `breakTwin` (Alt) leaves it alone too, and makes the anchor a corner.
 */
export function withHandle(anchor: Anchor, side: HandleSide, to: Xy, breakTwin = false): Anchor {
  const moved = setHandle(anchor, side, to)
  if (breakTwin) return { ...moved, kind: 'corner' }
  const twin: HandleSide = side === 'in' ? 'out' : 'in'
  if (anchor.kind === 'symmetric') return setHandle(moved, twin, [neg(to[0]), neg(to[1])])
  if (anchor.kind === 'corner') return moved
  const toLength = Math.hypot(to[0], to[1])
  if (toLength === 0) return moved
  const twinLength = Math.hypot(...handleOf(anchor, twin))
  const scale = twinLength / toLength
  return setHandle(moved, twin, [neg(to[0] * scale), neg(to[1] * scale)])
}

/**
 * The anchor as another kind. A smooth anchor turns its in handle to line up with the out handle,
 * and a symmetric one also makes it as long; without an out handle, the in handle leads.
 */
export function withKind(anchor: Anchor, kind: AnchorKind): Anchor {
  const next = { ...anchor, kind }
  if (kind === 'corner') return next
  const lead: HandleSide = hasHandle(anchor, 'out') ? 'out' : 'in'
  return withHandle(next, lead, handleOf(anchor, lead))
}

/**
 * Anchor `index` of a path as another kind, as withKind makes it. A smooth or symmetric anchor
 * without handles also pulls out a pair parallel to the line between its neighbors, reaching a
 * third of the way to each (a symmetric one splits the difference), so a clicked corner can
 * become a curve without a drag.
 */
export function anchorWithKind(
  anchors: readonly Anchor[],
  closed: boolean,
  index: number,
  kind: AnchorKind,
): Anchor {
  const anchor = anchors[index]
  if (kind === 'corner' || hasHandle(anchor, 'in') || hasHandle(anchor, 'out')) {
    return withKind(anchor, kind)
  }
  const n = anchors.length
  const prev = n > 1 && (closed || index > 0) ? anchors[(index - 1 + n) % n] : null
  const next = n > 1 && (closed || index < n - 1) ? anchors[(index + 1) % n] : null
  const from = prev ?? anchor
  const to = next ?? anchor
  const span = Math.hypot(to.x - from.x, to.y - from.y)
  if (span === 0) return { ...anchor, kind }
  const [ux, uy] = [(to.x - from.x) / span, (to.y - from.y) / span]
  let inLength = prev ? Math.hypot(anchor.x - prev.x, anchor.y - prev.y) / 3 : 0
  let outLength = next ? Math.hypot(next.x - anchor.x, next.y - anchor.y) / 3 : 0
  if (kind === 'symmetric') {
    inLength = outLength = prev && next ? (inLength + outLength) / 2 : inLength + outLength
  }
  return {
    ...anchor,
    kind,
    inX: neg(ux * inLength),
    inY: neg(uy * inLength),
    outX: ux * outLength,
    outY: uy * outLength,
  }
}

/**
 * The anchors with a new one at `t` (0..1) along segment `segment`. A curved segment is split
 * exactly, so the path keeps its shape: the new anchor is smooth, and the neighbors' handles
 * shorten. A straight segment gets a corner anchor and stays straight.
 */
export function insertAnchor(
  anchors: readonly Anchor[],
  closed: boolean,
  segment: number,
  t: number,
): Anchor[] {
  const cubic = pathSegments(anchors, closed)[segment]
  if (!cubic) return [...anchors]
  const i = segment
  const j = (segment + 1) % anchors.length
  const a = anchors[i]
  const b = anchors[j]
  const next = [...anchors]
  let added: Anchor
  if (!hasHandle(a, 'out') && !hasHandle(b, 'in')) {
    added = corner(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t)
  } else {
    const { left, right } = new Bezier(...cubic.flat()).split(t)
    const [, l1, l2, mid] = left.points
    const [, r1, r2] = right.points
    next[i] = { ...a, outX: l1.x - a.x, outY: l1.y - a.y }
    next[j] = { ...b, inX: r2.x - b.x, inY: r2.y - b.y }
    added = {
      x: mid.x,
      y: mid.y,
      inX: l2.x - mid.x,
      inY: l2.y - mid.y,
      outX: r1.x - mid.x,
      outY: r1.y - mid.y,
      kind: 'smooth',
    }
  }
  next.splice(i + 1, 0, added)
  return next
}

export function corner(x: number, y: number): Anchor {
  return { x, y, inX: 0, inY: 0, outX: 0, outY: 0, kind: 'corner' }
}

function smooth(x: number, y: number, inX: number, inY: number, outX: number, outY: number) {
  return { x, y, inX, inY, outX, outY, kind: 'smooth' } satisfies Anchor
}

/**
 * Anchors that sit on top of their neighbor become one, with the in handle of the first and the
 * out handle of the second; on a closed path the last and first count as neighbors.
 */
function mergeCoincident(anchors: Anchor[]): Anchor[] {
  const merged: Anchor[] = []
  for (const anchor of anchors) {
    const prev = merged.at(-1)
    if (prev && prev.x === anchor.x && prev.y === anchor.y) {
      merged[merged.length - 1] = { ...prev, outX: anchor.outX, outY: anchor.outY }
    } else merged.push(anchor)
  }
  const first = merged[0]
  const last = merged.at(-1)!
  if (merged.length > 1 && first.x === last.x && first.y === last.y) {
    merged[0] = { ...first, inX: last.inX, inY: last.inY }
    merged.pop()
  }
  return merged
}

/** A rectangle's outline from (0, 0), clockwise; each rounded corner is a quarter circle. */
function rectAnchors(width: number, height: number, cornerRadius: number): Anchor[] {
  const r = Math.max(0, Math.min(cornerRadius, width / 2, height / 2))
  if (r === 0) return [corner(0, 0), corner(width, 0), corner(width, height), corner(0, height)]
  const k = KAPPA * r
  // Each corner starts with an out handle and ends with an in handle; the sides are straight.
  return mergeCoincident([
    smooth(r, 0, -k, 0, 0, 0),
    smooth(width - r, 0, 0, 0, k, 0),
    smooth(width, r, 0, -k, 0, 0),
    smooth(width, height - r, 0, 0, 0, k),
    smooth(width - r, height, k, 0, 0, 0),
    smooth(r, height, 0, 0, -k, 0),
    smooth(0, height - r, 0, k, 0, 0),
    smooth(0, r, 0, 0, 0, -k),
  ])
}

/** An ellipse around (0, 0): 4 symmetric anchors, clockwise from the right. */
function ellipseAnchors(rx: number, ry: number): Anchor[] {
  const kx = KAPPA * rx
  const ky = KAPPA * ry
  const symmetric = (x: number, y: number, outX: number, outY: number): Anchor => ({
    x,
    y,
    inX: neg(outX),
    inY: neg(outY),
    outX,
    outY,
    kind: 'symmetric',
  })
  return [
    symmetric(rx, 0, 0, ky),
    symmetric(0, ry, neg(kx), 0),
    symmetric(neg(rx), 0, 0, neg(ky)),
    symmetric(0, neg(ry), kx, 0),
  ]
}

/** A rectangle, ellipse or line as path anchors in the shape's own coordinates. */
export function shapeAnchors(node: NodeOf<'rect' | 'ellipse' | 'line'>): {
  anchors: Anchor[]
  closed: boolean
} {
  switch (node.type) {
    case 'rect':
      return { anchors: rectAnchors(node.width, node.height, node.cornerRadius), closed: true }
    case 'ellipse':
      return { anchors: ellipseAnchors(node.rx, node.ry), closed: true }
    case 'line': {
      const [x1, y1, x2, y2] = node.points
      return { anchors: [corner(x1, y1), corner(x2, y2)], closed: false }
    }
  }
}
