import { IDENTITY_TRANSFORM, type NodeId, type Transform, type VectorNode } from '../../types'
import { applyTransform, nodeBounds, type Box } from '../geometry/bounds'
import {
  absoluteTransform,
  bakeTransform,
  bakeTransforms,
  composeTransform,
  isAxisAligned,
  normalizeRotation,
  parentTransform,
  relativeTransform,
} from '../geometry/transform'
import { strokeOutlineBox } from '../strokePath'
import { addMoves, boxOf, type Axis, type Patch } from './align'

// The properties panel's X, Y, W, H and rotation fields. They show and set the selection's ink
// box on the canvas, the box align and snapping go by, and its rotation on the canvas.

type Nodes = Readonly<Record<NodeId, VectorNode>>

/** The nodes with the patch applied, for measuring what it would do. */
export function withPatch(nodes: Nodes, patch: Patch): Nodes {
  const next: Record<NodeId, VectorNode> = { ...nodes }
  for (const [id, changes] of Object.entries(patch)) {
    if (nodes[id]) next[id] = { ...nodes[id], ...changes } as VectorNode
  }
  return next
}

/** The rotation on the canvas the nodes share, in degrees; null when they differ or there are none. */
export function sharedRotation(nodes: Nodes, ids: readonly NodeId[]): number | null {
  const rotations = ids.flatMap((id) => (nodes[id] ? [absoluteTransform(nodes, id).rotation] : []))
  if (rotations.length === 0) return null
  return rotations.every((r) => Math.abs(r - rotations[0]) < 1e-6) ? rotations[0] : null
}

/**
 * Whether the box can stretch along one axis alone: everything in it is turned on the canvas by
 * a multiple of 90°, since a turned object would need a skew, which the model has none of. A
 * single text keeps its ratio too, as at the Transformer's corners, since its height follows its
 * lines.
 */
export function canStretch(nodes: Nodes, ids: readonly NodeId[]): boolean {
  if (ids.length === 1 && nodes[ids[0]]?.type === 'text') return false
  return ids.every(
    (id) => absoluteTransform(nodes, id).rotation % 90 === 0 && isAxisAligned(nodes, id),
  )
}

/** The moves that put the box's top-left corner at (x, y); null leaves that axis alone. */
export function movePatch(
  nodes: Nodes,
  ids: readonly NodeId[],
  x: number | null,
  y: number | null,
): Patch {
  const box = boxOf(nodes, ids)
  if (!box) return {}
  const dx = x === null ? 0 : x - box.minX
  const dy = y === null ? 0 : y - box.minY
  return addMoves(
    nodes,
    {},
    ids.filter((id) => !nodes[id]?.locked).map((id) => [id, dx, dy] as const),
  )
}

/**
 * The changes that scale the nodes by (sx, sy) along the canvas axes about the canvas point
 * (px, py), baked as a Transformer resize is: outlines keep their widths, and freehand strokes
 * keep the scale in their transform. Locked nodes stay as they are.
 */
function scalePatch(
  nodes: Nodes,
  ids: readonly NodeId[],
  sx: number,
  sy: number,
  px: number,
  py: number,
): Patch {
  const frame: Transform = {
    x: px * (1 - sx),
    y: py * (1 - sy),
    rotation: 0,
    scaleX: sx,
    scaleY: sy,
  }
  const patch: Patch = {}
  for (const id of ids) {
    const node = nodes[id]
    if (!node || node.locked) continue
    const absolute = composeTransform(frame, absoluteTransform(nodes, id))
    Object.assign(
      patch,
      bakeTransforms(nodes, node, relativeTransform(parentTransform(nodes, id), absolute)),
    )
  }
  return patch
}

const extentOf = (box: Box, axis: Axis) =>
  axis === 'x' ? box.maxX - box.minX : box.maxY - box.minY

/**
 * The changes that make the box `length` long along the axis, keeping its top-left corner where
 * it is; `keepRatio` scales the other axis by as much. Outlines keep their width, so the box
 * doesn't grow in proportion to the scale: a secant search finds the scale that gives the
 * length, exact within a few steps, since the box's extent is piecewise linear in it. A box can't
 * shrink below the size its outlines alone give it. Empty when nothing changes.
 */
export function resizePatch(
  nodes: Nodes,
  ids: readonly NodeId[],
  axis: Axis,
  length: number,
  keepRatio: boolean,
): Patch {
  const box = boxOf(nodes, ids)
  if (!box || !Number.isFinite(length) || length <= 0) return {}
  const current = extentOf(box, axis)
  if (current <= 0 || Math.abs(length - current) < 1e-9) return {}

  const scaled = (s: number) => {
    const sx = axis === 'x' || keepRatio ? s : 1
    const sy = axis === 'y' || keepRatio ? s : 1
    const patch = scalePatch(nodes, ids, sx, sy, box.minX, box.minY)
    const after = boxOf(withPatch(nodes, patch), ids)
    return { patch, after, error: after ? Math.abs(extentOf(after, axis) - length) : Infinity }
  }
  // Content without outlines is at least a unit long.
  const minScale = 1 / current
  let s0 = 1
  let f0 = current
  let s1 = Math.max(minScale, length / current)
  let best = scaled(s1)
  let f1 = best.after ? extentOf(best.after, axis) : f0
  for (let i = 0; i < 20 && best.error > 1e-6 && f1 !== f0; i++) {
    const s2 = Math.max(minScale, s1 + ((length - f1) * (s1 - s0)) / (f1 - f0))
    if (!Number.isFinite(s2) || s2 === s1) break
    const next = scaled(s2)
    if (!next.after) break
    s0 = s1
    f0 = f1
    s1 = s2
    f1 = extentOf(next.after, axis)
    if (next.error < best.error) best = next
  }
  if (!best.after) return {}
  // Outlines that don't scale move the box's corner; it goes back.
  return addMoves(
    nodes,
    best.patch,
    Object.keys(best.patch)
      .filter((id) => ids.includes(id))
      .map((id) => [id, box.minX - best.after!.minX, box.minY - best.after!.minY] as const),
  )
}

/** The box the node's own geometry fills, before its transform: what it turns about. */
function localBox(nodes: Nodes, node: VectorNode): Box | null {
  if (node.type === 'stroke') return strokeOutlineBox(node)
  return nodeBounds({ ...node, transform: IDENTITY_TRANSFORM }, nodes)
}

/**
 * The changes that turn each node to `degrees` on the canvas about the middle of its own box, as
 * the Transformer's rotater turns a single object. Locked nodes stay as they are.
 */
export function rotatePatch(nodes: Nodes, ids: readonly NodeId[], degrees: number): Patch {
  if (!Number.isFinite(degrees)) return {}
  const rotation = normalizeRotation(degrees)
  const patch: Patch = {}
  for (const id of ids) {
    const node = nodes[id]
    if (!node || node.locked) continue
    const absolute = absoluteTransform(nodes, id)
    const local = localBox(nodes, node)
    if (!local || absolute.rotation === rotation) continue
    const cx = (local.minX + local.maxX) / 2
    const cy = (local.minY + local.maxY) / 2
    const [px, py] = applyTransform(absolute, cx, cy)
    const turned = { ...absolute, x: 0, y: 0, rotation }
    const [ox, oy] = applyTransform(turned, cx, cy)
    const next = relativeTransform(parentTransform(nodes, id), {
      ...turned,
      x: px - ox,
      y: py - oy,
    })
    const changes = bakeTransform(node, next)
    if (changes) patch[id] = changes
  }
  return patch
}
