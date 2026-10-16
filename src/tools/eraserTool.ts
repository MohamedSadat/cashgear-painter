import { nodeHitsSegment } from '../lib/geometry/hitTest'
import { absoluteTransform, sameTransform } from '../lib/geometry/transform'
import { isPickable, useEditorStore } from '../store/editorStore'
import type { Doc, NodeId, VectorNode } from '../types'
import type { ToolController } from './types'

const store = () => useEditorStore.getState()

let last: [number, number] | null = null
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
 * Object eraser: touched objects dim while erasing and are deleted together, one undo step, on
 * release. A group it empties goes too.
 */
export const eraserTool: ToolController = {
  cursor: 'crosshair',

  onDown(e) {
    hits.clear()
    last = e.point
    sweep(e.point, e.point)
  },

  onMove(e) {
    if (!last) return
    sweep(last, e.point)
    last = e.point
  },

  onUp() {
    if (!last) return
    last = null
    const ids = [...hits]
    hits.clear()
    if (ids.length > 0) store().deleteNodes(ids)
    store().setErasing([])
  },

  onCancel() {
    last = null
    hits.clear()
    store().setErasing([])
  },
}
