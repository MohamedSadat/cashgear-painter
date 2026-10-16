import { eraseSplitPlaced, type EraserPath } from '../lib/geometry/eraseSplit'
import { nodeHitsSegment } from '../lib/geometry/hitTest'
import { absoluteTransform, sameTransform } from '../lib/geometry/transform'
import { isPickable, useEditorStore, type EraserMode } from '../store/editorStore'
import type { Doc, NodeId, Point, VectorNode } from '../types'
import type { ToolController } from './types'

const store = () => useEditorStore.getState()

let last: [number, number] | null = null
// The mode of the pass in progress: switching modes mid-pass doesn't change it.
let mode: EraserMode = 'object'
const hits = new Set<NodeId>()

// A node in a group as it lies on the canvas, kept while neither it nor its groups' transforms
// change, so the hit test's own caches keep working.
const placedCache = new WeakMap<VectorNode, VectorNode>()

function onCanvas(doc: Doc, node: VectorNode): VectorNode {
  if (node.parentId === null) return node
  const transform = absoluteTransform(doc.nodes, node.id)
  const cached = placedCache.get(node)
  if (cached && sameTransform(cached.transform, transform)) return cached
  const placed = { ...node, transform }
  placedCache.set(node, placed)
  return placed
}

/**
 * Collects the objects the eraser circle touches on its way from a to b: visible, unlocked ones,
 * including those inside groups, which it erases one by one rather than the whole group.
 */
function sweep(a: [number, number], b: [number, number]) {
  const { doc, brush } = store()
  const radius = brush.size / 2
  let found = false
  for (const node of Object.values(doc.nodes)) {
    if (node.type === 'group' || hits.has(node.id) || !isPickable(doc, node.id)) continue
    if (nodeHitsSegment(onCanvas(doc, node), a, b, radius)) {
      hits.add(node.id)
      found = true
    }
  }
  if (found) store().setErasing([...hits])
}

/**
 * Cuts the part of every visible, unlocked freehand stroke that the eraser circle covers on its
 * way from a to b, where the stroke lies on the canvas, groups and its own transform included.
 * Other objects are left alone.
 */
function cut(a: [number, number], b: [number, number]) {
  const { doc, brush } = store()
  const radius = brush.size / 2
  const eraser: EraserPath = {
    points: [
      [a[0], a[1], 0.5],
      [b[0], b[1], 0.5],
    ],
    size: brush.size,
  }
  const cuts: Record<NodeId, Point[][]> = {}
  let found = false
  for (const node of Object.values(doc.nodes)) {
    if (node.type !== 'stroke' || !isPickable(doc, node.id)) continue
    const placed = onCanvas(doc, node)
    if (!nodeHitsSegment(placed, a, b, radius)) continue
    const runs = eraseSplitPlaced(node.points, node.size, placed.transform, eraser)
    if (runs.length === 1 && runs[0] === node.points) continue
    cuts[node.id] = runs
    found = true
  }
  if (found) store().splitStrokes(cuts)
}

/**
 * The eraser, in the store's eraser mode. Object: touched objects dim while erasing and are
 * deleted together, one undo step, on release; a group it empties goes too. Split: freehand
 * strokes are cut as the eraser moves, inside one gesture, so the pass is one undo step; a stroke
 * with nothing left goes, and so does a group it empties.
 */
export const eraserTool: ToolController = {
  cursor: 'crosshair',

  onDown(e) {
    mode = store().eraserMode
    last = e.point
    if (mode === 'split') {
      store().beginGesture()
      cut(e.point, e.point)
      return
    }
    hits.clear()
    sweep(e.point, e.point)
  },

  onMove(e) {
    if (!last) return
    if (mode === 'split') cut(last, e.point)
    else sweep(last, e.point)
    last = e.point
  },

  onUp() {
    if (!last) return
    last = null
    if (mode === 'split') {
      store().endGesture()
      return
    }
    const ids = [...hits]
    hits.clear()
    if (ids.length > 0) store().deleteNodes(ids)
    store().setErasing([])
  },

  onCancel() {
    // A split pass puts back what it cut; a tool switch with no pass going on changes nothing.
    if (last && mode === 'split') store().cancelGesture()
    last = null
    hits.clear()
    store().setErasing([])
  },
}
