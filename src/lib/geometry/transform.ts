import {
  IDENTITY_TRANSFORM,
  type Anchor,
  type GroupNode,
  type NodeId,
  type NodeOf,
  type Transform,
  type VectorNode,
} from '../../types'
import { applyTransform, invertTransform } from './bounds'

type Nodes = Readonly<Record<NodeId, VectorNode>>

/** Degrees in (-180, 180], so a full turn back reads as no rotation. */
export function normalizeRotation(degrees: number): number {
  const turned = (((degrees % 360) + 540) % 360) - 180
  // Rounding hides float noise such as 89.99999999999999 from Konva's matrix math.
  const rounded = Math.round(turned * 1e6) / 1e6
  return rounded === -180 ? 180 : rounded
}

/**
 * `to`, swung around `from` to the nearest multiple of `stepDegrees` while keeping its distance:
 * Shift's 45° snap for lines. Float noise such as 6e-17 is rounded away.
 */
export function snapAngle(
  from: readonly [number, number],
  to: readonly [number, number],
  stepDegrees = 45,
): [number, number] {
  const dx = to[0] - from[0]
  const dy = to[1] - from[1]
  const length = Math.hypot(dx, dy)
  const step = (stepDegrees * Math.PI) / 180
  const angle = Math.round(Math.atan2(dy, dx) / step) * step
  const clean = (n: number) => Math.round(n * 1e9) / 1e9
  return [clean(from[0] + Math.cos(angle) * length), clean(from[1] + Math.sin(angle) * length)]
}

export function sameTransform(a: Transform, b: Transform): boolean {
  return (
    a.x === b.x &&
    a.y === b.y &&
    a.rotation === b.rotation &&
    a.scaleX === b.scaleX &&
    a.scaleY === b.scaleY
  )
}

function scaleAnchor(a: Anchor, sx: number, sy: number): Anchor {
  return {
    ...a,
    x: a.x * sx,
    y: a.y * sy,
    inX: a.inX * sx,
    inY: a.inY * sy,
    outX: a.outX * sx,
    outY: a.outY * sy,
  }
}

const DEG = Math.PI / 180

/**
 * A scale of (sx, sy) as a node turned by `rotation` degrees sees it along its own axes. Exact when
 * the scale is uniform or the turn a multiple of 90°; otherwise the closest scale without skew,
 * which the model can't hold.
 */
export function scaleAlong(sx: number, sy: number, rotation: number): [number, number] {
  if (sx === sy) return [sx, sy]
  const cos = Math.cos(rotation * DEG)
  const sin = Math.sin(rotation * DEG)
  const clean = (n: number) => Math.round(n * 1e9) / 1e9
  return [clean(Math.hypot(sx * cos, sy * sin)), clean(Math.hypot(sx * sin, sy * cos))]
}

/** An affine map as SVG's matrix(a b c d e f): x' = a x + c y + e, y' = b x + d y + f. */
export type Affine = [a: number, b: number, c: number, d: number, e: number, f: number]

/** The transform as an affine map, in Konva's order: scale, then rotate, then translate. */
export function affineOf(t: Transform): Affine {
  const cos = Math.cos(t.rotation * DEG)
  const sin = t.rotation === 0 ? 0 : Math.sin(t.rotation * DEG)
  return [t.scaleX * cos, t.scaleX * sin, -t.scaleY * sin, t.scaleY * cos, t.x, t.y]
}

/** `m` after `n`: the map that applies n, then m. */
export function multiplyAffine(m: Affine, n: Affine): Affine {
  const [a, b, c, d, e, f] = m
  const [na, nb, nc, nd, ne, nf] = n
  return [
    a * na + c * nb,
    b * na + d * nb,
    a * nc + c * nd,
    b * nc + d * nd,
    a * ne + c * nf + e,
    b * ne + d * nf + f,
  ]
}

/** The map that undoes `m`; null when it flattens the plane. */
export function invertAffine([a, b, c, d, e, f]: Affine): Affine | null {
  const det = a * d - b * c
  if (!(Math.abs(det) > 1e-12)) return null
  return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det]
}

export function applyAffine([a, b, c, d, e, f]: Affine, x: number, y: number): [number, number] {
  return [a * x + c * y + e, b * x + d * y + f]
}

/** The transform `child` has on the canvas when its parent has the transform `parent`. */
export function composeTransform(parent: Transform, child: Transform): Transform {
  const [x, y] = applyTransform(parent, child.x, child.y)
  const [sx, sy] = scaleAlong(parent.scaleX, parent.scaleY, child.rotation)
  return {
    x,
    y,
    rotation: normalizeRotation(parent.rotation + child.rotation),
    scaleX: child.scaleX * sx,
    scaleY: child.scaleY * sy,
  }
}

/** The transform that `composeTransform(parent, ·)` turns into `absolute`: its inverse. */
export function relativeTransform(parent: Transform, absolute: Transform): Transform {
  const [x, y] = invertTransform(parent, absolute.x, absolute.y)
  const rotation = normalizeRotation(absolute.rotation - parent.rotation)
  const [sx, sy] = scaleAlong(parent.scaleX, parent.scaleY, rotation)
  return { x, y, rotation, scaleX: absolute.scaleX / sx, scaleY: absolute.scaleY / sy }
}

/** The transform of the node's parent on the canvas: its groups' transforms combined. */
export function parentTransform(nodes: Nodes, id: NodeId): Transform {
  const parentId = nodes[id]?.parentId ?? null
  return parentId === null ? IDENTITY_TRANSFORM : absoluteTransform(nodes, parentId)
}

/** The node's transform on the canvas, through every group it is in. */
export function absoluteTransform(nodes: Nodes, id: NodeId): Transform {
  const node = nodes[id]
  if (!node) return IDENTITY_TRANSFORM
  if (node.parentId === null) return node.transform
  return composeTransform(parentTransform(nodes, id), node.transform)
}

/** A canvas-space move of (dx, dy) as the node's parent sees it, for moving a node in a group. */
export function deltaInParent(nodes: Nodes, id: NodeId, dx: number, dy: number): [number, number] {
  const parent = parentTransform(nodes, id)
  return invertTransform(parent, parent.x + dx, parent.y + dy)
}

/**
 * The changes that give `node` the transform `next`, as a Transformer leaves it. Scale is baked
 * into geometry and reset to 1, so outlines keep their width: sizes for rects and ellipses, points
 * for lines, anchors and handles for paths, and width and font size for text (corner handles
 * scale both, side handles only the width). Freehand strokes keep their scale, since a stroke's
 * outline is a fill and scales correctly. Groups take only the transform here; bakeTransforms
 * passes their scale on to their children. Null when nothing changes.
 */
export function bakeTransform(node: VectorNode, next: Transform): Partial<VectorNode> | null {
  const { scaleX: sx, scaleY: sy } = next
  if (node.type === 'stroke' || node.type === 'group' || (sx === 1 && sy === 1)) {
    return sameTransform(next, node.transform) ? null : { transform: next }
  }

  const transform: Transform = { ...next, scaleX: 1, scaleY: 1 }
  switch (node.type) {
    case 'rect':
      return { transform, width: node.width * Math.abs(sx), height: node.height * Math.abs(sy) }
    case 'ellipse':
      return { transform, rx: node.rx * Math.abs(sx), ry: node.ry * Math.abs(sy) }
    case 'line': {
      const [x1, y1, x2, y2] = node.points
      return { transform, points: [x1 * sx, y1 * sy, x2 * sx, y2 * sy] }
    }
    case 'path':
      return {
        transform,
        contours: node.contours.map((c) => ({
          ...c,
          anchors: c.anchors.map((a) => scaleAnchor(a, sx, sy)),
        })),
      }
    case 'text':
      return { transform, width: node.width * Math.abs(sx), fontSize: node.fontSize * Math.abs(sy) }
  }
}

/**
 * Scales a group's children by (sx, sy) in the group's own coordinates, so the group can keep a
 * scale of 1: positions scale, and each child bakes the scale along its own axes as bakeTransform
 * does. Nested groups pass it on. Exact for a uniform scale, and for children turned by multiples
 * of 90°; the Transformer keeps the ratio for groups with other turns inside.
 */
function scaleChildren(
  nodes: Nodes,
  group: GroupNode,
  sx: number,
  sy: number,
  patch: Record<NodeId, Partial<VectorNode>>,
): void {
  for (const id of group.childIds) {
    const child = nodes[id]
    if (!child) continue
    const t = child.transform
    const [lx, ly] = scaleAlong(sx, sy, t.rotation)
    const moved = { ...t, x: t.x * sx, y: t.y * sy }
    if (child.type === 'group') {
      patch[id] = { transform: moved }
      scaleChildren(nodes, child, lx, ly, patch)
      continue
    }
    const changes = bakeTransform(child, { ...moved, scaleX: t.scaleX * lx, scaleY: t.scaleY * ly })
    if (changes) patch[id] = changes
  }
}

/**
 * bakeTransform for a node and, when it is a group, its descendants: a group's scale goes into
 * its children, so their outlines and fonts keep their sizes. Empty when nothing changes.
 */
export function bakeTransforms(
  nodes: Nodes,
  node: VectorNode,
  next: Transform,
): Record<NodeId, Partial<VectorNode>> {
  const patch: Record<NodeId, Partial<VectorNode>> = {}
  if (node.type !== 'group' || (next.scaleX === 1 && next.scaleY === 1)) {
    const changes = bakeTransform(node, next)
    if (changes) patch[node.id] = changes
    return patch
  }
  patch[node.id] = { transform: { ...next, scaleX: 1, scaleY: 1 } }
  scaleChildren(nodes, node, next.scaleX, next.scaleY, patch)
  return patch
}

/**
 * The changes that scale a page's content by `s` about its top-left corner and then move it by
 * (dx, dy), as a page's Scale content does: every top-level node is baked as bakeTransforms bakes
 * a resize, and outlines and corner radii scale too, so the drawing looks the same, only larger
 * or smaller. Freehand strokes keep the scale in their transform, outline and all.
 */
export function scaleContent(
  nodes: Nodes,
  rootIds: readonly NodeId[],
  s: number,
  dx: number,
  dy: number,
): Record<NodeId, Partial<VectorNode>> {
  const patch: Record<NodeId, Partial<VectorNode>> = {}
  const frame: Transform = { x: dx, y: dy, rotation: 0, scaleX: s, scaleY: s }
  const scaleLooks = (id: NodeId) => {
    const node = nodes[id]
    if (!node) return
    if (node.type === 'group') {
      node.childIds.forEach(scaleLooks)
      return
    }
    const changes: Partial<VectorNode> = { ...patch[id] }
    if (node.style.stroke !== null && node.type !== 'stroke' && node.type !== 'text') {
      changes.style = { ...node.style, strokeWidth: node.style.strokeWidth * s }
    }
    if (node.type === 'rect')
      (changes as Partial<NodeOf<'rect'>>).cornerRadius = node.cornerRadius * s
    if (Object.keys(changes).length > 0) patch[id] = changes
  }
  for (const id of rootIds) {
    const node = nodes[id]
    if (!node) continue
    Object.assign(patch, bakeTransforms(nodes, node, composeTransform(frame, node.transform)))
    if (s !== 1) scaleLooks(id)
  }
  return patch
}

/** Whether the node, and everything in it when it is a group, is turned by a multiple of 90°. */
export function isAxisAligned(nodes: Nodes, id: NodeId): boolean {
  const node = nodes[id]
  if (!node) return true
  if (node.transform.rotation % 90 !== 0) return false
  return node.type !== 'group' || node.childIds.every((child) => isAxisAligned(nodes, child))
}
