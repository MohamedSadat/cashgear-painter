import { nodeHitsSegment } from '../lib/geometry/hitTest'
import { useEditorStore } from '../store/editorStore'
import type { NodeId } from '../types'
import type { ToolController } from './types'

const store = () => useEditorStore.getState()

let last: [number, number] | null = null
const hits = new Set<NodeId>()

/** Collects the visible, unlocked nodes the eraser circle touches on its way from a to b. */
function sweep(a: [number, number], b: [number, number]) {
  const { doc, brush } = store()
  const radius = brush.size / 2
  let found = false
  for (const node of Object.values(doc.nodes)) {
    if (hits.has(node.id) || node.hidden || node.locked) continue
    if (nodeHitsSegment(node, a, b, radius)) {
      hits.add(node.id)
      found = true
    }
  }
  if (found) store().setErasing([...hits])
}

/** Object eraser: touched nodes dim while erasing and are deleted together, one undo step, on release. */
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
