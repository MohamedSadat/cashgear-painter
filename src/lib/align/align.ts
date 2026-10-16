import type { NodeId, Transform, VectorNode } from '../../types'
import { inkBounds, unionBoxes, type Box } from '../geometry/bounds'
import { deltaInParent } from '../geometry/transform'

type Nodes = Readonly<Record<NodeId, VectorNode>>
export type Patch = Record<NodeId, Partial<VectorNode>>

/** An edge or center line that align commands line objects up on. */
export type AlignEdge = 'left' | 'center' | 'right' | 'top' | 'middle' | 'bottom'
export type Axis = 'x' | 'y'

export const AXIS_OF: Record<AlignEdge, Axis> = {
  left: 'x',
  center: 'x',
  right: 'x',
  top: 'y',
  middle: 'y',
  bottom: 'y',
}

// Moves smaller than this are float noise, not a change.
const EPSILON = 1e-9

/**
 * The box around the nodes' ink on the canvas, as snapping sees it: a rotated object by its
 * axis-aligned box, a freehand stroke by its drawn outline.
 */
export function boxOf(nodes: Nodes, ids: readonly NodeId[]): Box | null {
  return unionBoxes(ids.map((id) => inkBounds(nodes, id)))
}

/** Where the line lies on the box. */
export function lineOf(box: Box, where: AlignEdge): number {
  switch (where) {
    case 'left':
      return box.minX
    case 'center':
      return (box.minX + box.maxX) / 2
    case 'right':
      return box.maxX
    case 'top':
      return box.minY
    case 'middle':
      return (box.minY + box.maxY) / 2
    case 'bottom':
      return box.maxY
  }
}

/**
 * Adds to `patch` a move of each node by its canvas delta, on top of any transform the patch
 * already gives it. A node in a turned group moves along the canvas, as a drag moves it. Missing
 * nodes and moves that are float noise are left out.
 */
export function addMoves(
  nodes: Nodes,
  patch: Patch,
  moves: Iterable<readonly [id: NodeId, dx: number, dy: number]>,
): Patch {
  for (const [id, dx, dy] of moves) {
    const node = nodes[id]
    if (!node || (Math.abs(dx) < EPSILON && Math.abs(dy) < EPSILON)) continue
    const t: Transform = patch[id]?.transform ?? node.transform
    const [x, y] = deltaInParent(nodes, id, dx, dy)
    patch[id] = { ...patch[id], transform: { ...t, x: t.x + x, y: t.y + y } }
  }
  return patch
}

interface Item {
  id: NodeId
  box: Box
  locked: boolean
}

/** The nodes that have a box, with it. */
function itemsOf(nodes: Nodes, ids: readonly NodeId[]): Item[] {
  return ids.flatMap((id) => {
    const box = inkBounds(nodes, id)
    return box ? [{ id, box, locked: nodes[id].locked }] : []
  })
}

/**
 * The moves that line the nodes up on an edge or center line, by their ink boxes. One node lines
 * up with the page; several with the box around them all, or, when some are locked, the box
 * around the locked ones, which stay put. `ids` should hold no node inside another of them.
 */
export function alignPatch(
  nodes: Nodes,
  ids: readonly NodeId[],
  where: AlignEdge,
  page: Box,
): Patch {
  const items = itemsOf(nodes, ids)
  if (items.length === 0) return {}
  const locked = items.filter((item) => item.locked)
  const reference =
    items.length === 1 ? page : unionBoxes((locked.length > 0 ? locked : items).map((i) => i.box))!
  const target = lineOf(reference, where)
  const horizontal = AXIS_OF[where] === 'x'
  return addMoves(
    nodes,
    {},
    items
      .filter((item) => !item.locked)
      .map((item) => {
        const d = target - lineOf(item.box, where)
        return [item.id, horizontal ? d : 0, horizontal ? 0 : d] as const
      }),
  )
}

/**
 * The moves that make the gaps between the nodes equal along the axis, by their ink boxes, in
 * the order of their centers. The first and last stay put, and so do locked nodes; the ones
 * between each two that stay are spaced evenly. Nothing for fewer than 3 nodes.
 */
export function distributePatch(nodes: Nodes, ids: readonly NodeId[], axis: Axis): Patch {
  const items = itemsOf(nodes, ids)
  if (items.length < 3) return {}
  const lo = axis === 'x' ? 'minX' : 'minY'
  const hi = axis === 'x' ? 'maxX' : 'maxY'
  const size = (box: Box) => box[hi] - box[lo]
  const center = (box: Box) => (box[lo] + box[hi]) / 2
  // A stable sort: objects centered on the same line keep their z-order.
  const sorted = [...items].sort((a, b) => center(a.box) - center(b.box))
  const fixed = sorted.flatMap((item, i) =>
    i === 0 || i === sorted.length - 1 || item.locked ? [i] : [],
  )
  const moves: [NodeId, number, number][] = []
  for (let k = 0; k + 1 < fixed.length; k++) {
    const first = sorted[fixed[k]]
    const last = sorted[fixed[k + 1]]
    const inner = sorted.slice(fixed[k] + 1, fixed[k + 1])
    if (inner.length === 0) continue
    const filled = inner.reduce((sum, item) => sum + size(item.box), 0)
    const gap = (last.box[lo] - first.box[hi] - filled) / (inner.length + 1)
    let at = first.box[hi] + gap
    for (const item of inner) {
      const d = at - item.box[lo]
      moves.push(axis === 'x' ? [item.id, d, 0] : [item.id, 0, d])
      at += size(item.box) + gap
    }
  }
  return addMoves(nodes, {}, moves)
}
