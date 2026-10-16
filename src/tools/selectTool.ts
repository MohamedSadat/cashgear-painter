import { nodeBounds, type Box } from '../lib/geometry/bounds'
import { useEditorStore, zoomOf, type Rect } from '../store/editorStore'
import type { Doc, NodeId, Transform } from '../types'
import type { ToolController } from './types'

const store = () => useEditorStore.getState()

// Screen pixels a press may wander before it becomes a drag.
const DRAG_SLOP = 3
const NUDGE = 1
const BIG_NUDGE = 10 // with Shift

const ARROWS: Record<string, [number, number]> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
}

type Xy = [number, number]

type Drag =
  // Down, but not yet far enough to be a drag; `target` is the top-level node under the pointer.
  | {
      kind: 'press'
      start: Xy
      target: NodeId | null
      shift: boolean
      wasSelected: boolean
      inSelection: boolean // on empty canvas, but inside the selection's box
    }
  | { kind: 'move'; start: Xy; origins: Map<NodeId, Transform> }
  | { kind: 'marquee'; start: Xy; base: NodeId[] }

let drag: Drag | null = null

/** The top-level node that `id` belongs to: clicking inside a group picks the group. */
export function topLevelId(doc: Doc, id: NodeId): NodeId | null {
  let node = doc.nodes[id]
  while (node && node.parentId !== null) node = doc.nodes[node.parentId]
  return node?.id ?? null
}

/** The box around the nodes' bounds; null when none of them has bounds. */
export function unionBounds(doc: Doc, ids: NodeId[]): Box | null {
  let union: Box | null = null
  for (const id of ids) {
    const node = doc.nodes[id]
    const box = node ? nodeBounds(node) : null
    if (!box) continue
    union = union
      ? {
          minX: Math.min(union.minX, box.minX),
          minY: Math.min(union.minY, box.minY),
          maxX: Math.max(union.maxX, box.maxX),
          maxY: Math.max(union.maxY, box.maxY),
        }
      : box
  }
  return union
}

/** The visible, unlocked top-level nodes whose bounds lie fully inside the rectangle. */
export function nodesInRect(doc: Doc, rect: Rect): NodeId[] {
  return doc.rootIds.filter((id) => {
    const node = doc.nodes[id]
    if (!node || node.hidden || node.locked) return false
    const box = nodeBounds(node)
    return (
      box !== null &&
      box.minX >= rect.x &&
      box.minY >= rect.y &&
      box.maxX <= rect.x + rect.width &&
      box.maxY <= rect.y + rect.height
    )
  })
}

function rectBetween(a: Xy, b: Xy): Rect {
  return {
    x: Math.min(a[0], b[0]),
    y: Math.min(a[1], b[1]),
    width: Math.abs(a[0] - b[0]),
    height: Math.abs(a[1] - b[1]),
  }
}

const boxContains = (box: Box, [x, y]: Xy) =>
  x >= box.minX && x <= box.maxX && y >= box.minY && y <= box.maxY

/** Starts moving the unlocked selected nodes, as one undo step. */
function startMove(start: Xy): Drag {
  const { doc, selection } = store()
  const origins = new Map<NodeId, Transform>()
  for (const id of selection) {
    const node = doc.nodes[id]
    if (node && !node.locked) origins.set(id, node.transform)
  }
  store().beginGesture()
  return { kind: 'move', start, origins }
}

/**
 * Click selects and Shift-click adds (or, on a selected node, removes). Dragging a node or the
 * inside of the selection moves the selection; dragging empty canvas draws a marquee that selects
 * what lies fully inside it. Resize and rotate belong to the Transformer in SelectionOverlay.
 */
export const selectTool: ToolController = {
  cursor: 'default',
  picksNodes: true,

  onDown(e) {
    const { doc, selection } = store()
    const target = e.target === null ? null : topLevelId(doc, e.target)
    const wasSelected = target !== null && selection.includes(target)
    if (target !== null && !wasSelected) store().select([target], e.shift ? 'add' : 'replace')
    const box = target === null && !e.shift ? unionBounds(doc, selection) : null
    drag = {
      kind: 'press',
      start: e.point,
      target,
      shift: e.shift,
      wasSelected,
      inSelection: box !== null && boxContains(box, e.point),
    }
  },

  onMove(e) {
    if (!drag) return
    if (drag.kind === 'press') {
      const travel = Math.hypot(e.point[0] - drag.start[0], e.point[1] - drag.start[1])
      if (travel * zoomOf(store()) < DRAG_SLOP) return
      drag =
        drag.target !== null || drag.inSelection
          ? startMove(drag.start)
          : { kind: 'marquee', start: drag.start, base: drag.shift ? store().selection : [] }
    }

    if (drag.kind === 'move') {
      const dx = e.point[0] - drag.start[0]
      const dy = e.point[1] - drag.start[1]
      const patch: Record<NodeId, { transform: Transform }> = {}
      for (const [id, t] of drag.origins)
        patch[id] = { transform: { ...t, x: t.x + dx, y: t.y + dy } }
      store().updateNodes(patch)
    } else if (drag.kind === 'marquee') {
      const rect = rectBetween(drag.start, e.point)
      store().setMarquee(rect)
      store().select([...drag.base, ...nodesInRect(store().doc, rect)])
    }
  },

  onUp() {
    const finished = drag
    drag = null
    if (!finished) return
    if (finished.kind === 'move') store().endGesture()
    else if (finished.kind === 'marquee') store().setMarquee(null)
    else if (finished.target !== null) {
      // A click on a node that was already selected: Shift removes it, a plain click keeps only it.
      if (finished.wasSelected)
        store().select([finished.target], finished.shift ? 'toggle' : 'replace')
    } else if (!finished.shift) store().select([])
  },

  onKey(e) {
    if (e.key === 'Escape') {
      if (drag) {
        selectTool.onCancel?.()
        return true
      }
      if (store().selection.length === 0) return false
      store().select([])
      return true
    }
    const { selection } = store()
    if (drag || selection.length === 0 || e.altKey) return false

    if (!(e.ctrlKey || e.metaKey)) {
      if (e.key === 'Delete' || e.key === 'Backspace') {
        store().deleteNodes(selection)
        return true
      }
      const arrow = ARROWS[e.key]
      if (!arrow) return false
      const step = e.shiftKey ? BIG_NUDGE : NUDGE
      store().nudge(selection, arrow[0] * step, arrow[1] * step)
      return true
    }

    const key = e.key.toLowerCase()
    if (key === 'd') store().duplicate(selection)
    else if (key === 'c') store().copy(selection)
    else if (key === 'x') {
      store().copy(selection)
      store().deleteNodes(selection)
    }
    // By code, since Shift turns ] into } on most layouts.
    else if (e.code === 'BracketRight') store().reorder(selection, e.shiftKey ? 'front' : 'forward')
    else if (e.code === 'BracketLeft') store().reorder(selection, e.shiftKey ? 'back' : 'backward')
    else return false
    return true
  },

  onCancel() {
    const cancelled = drag
    drag = null
    if (cancelled?.kind === 'move') store().cancelGesture()
    else if (cancelled?.kind === 'marquee') store().setMarquee(null)
  },
}
