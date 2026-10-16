import { corner, withHandle, type Xy } from '../lib/geometry/pathData'
import { snapAngle } from '../lib/geometry/transform'
import { createPathNode, newNodeId, useEditorStore, zoomOf } from '../store/editorStore'
import type { Anchor, NodeId, Style } from '../types'
import type { ToolController, ToolEvent } from './types'

const store = () => useEditorStore.getState()

// Screen pixels a press must travel to pull out handles; a shorter one leaves a corner.
const DRAG_SLOP = 3
// Screen pixels around the first anchor where a press closes the path, and around the last where
// it ends it; fingers get more room.
export const CLOSE_RADIUS = 8
const TOUCH_CLOSE_RADIUS = 20

type Press =
  | { kind: 'anchor'; index: number; added: boolean } // dragging pulls out the anchor's handles
  | { kind: 'close' } // on the first anchor
  | { kind: 'end' } // on the last anchor

interface PenPath {
  id: NodeId
  style: Style
  anchors: Anchor[] // in canvas units until the path becomes a node
  press: Press | null
}

let pen: PenPath | null = null

function showDraft(path: PenPath) {
  store().setDraft(createPathNode(path.anchors, false, path.style, path.id))
}

const lastPoint = (path: PenPath): Xy => {
  const last = path.anchors[path.anchors.length - 1]
  return [last.x, last.y]
}

/** Whether the press is on the anchor, within the close radius. */
function isOn(anchor: Anchor, e: ToolEvent): boolean {
  const radius = e.pointerType === 'touch' ? TOUCH_CLOSE_RADIUS : CLOSE_RADIUS
  return Math.hypot(e.point[0] - anchor.x, e.point[1] - anchor.y) * zoomOf(store()) <= radius
}

/**
 * Ends the path being drawn. With 2 or more anchors it becomes a node, one undo step, and is
 * selected; `thenSelect` also switches to the select tool, as the shape tools do.
 */
function finish(closed: boolean, thenSelect: boolean) {
  const done = pen
  pen = null
  store().setDraft(null)
  store().setPenHover(null)
  if (!done || done.anchors.length < 2) return
  const node = createPathNode(done.anchors, closed, done.style, done.id)
  store().addNodes([node])
  store().select([node.id])
  if (thenSelect) store().setTool('select')
}

/** Drops the last anchor; with none left, the path is gone. */
function removeLastAnchor(path: PenPath) {
  path.anchors = path.anchors.slice(0, -1)
  if (path.anchors.length > 0) showDraft(path)
  else {
    pen = null
    store().setDraft(null)
    store().setPenHover(null)
  }
}

/** Ends an open path, as Enter does: the properties panel's button for touch screens. */
export function finishPath(): void {
  finish(false, true)
}

/**
 * Pen: a click adds a corner anchor and a click-drag a smooth one, its handles following the
 * pointer. A click on the first anchor closes the path, and one on the last anchor, Enter or Esc
 * ends it open. The path grows as a draft and becomes a node, one undo step, when it ends.
 * Backspace or Ctrl/Cmd + Z takes back the last anchor. Shift snaps to 45°.
 */
export const penTool: ToolController = {
  cursor: 'crosshair',

  onDown(e) {
    // A second press on a lone first anchor pulls out its handles again instead of doubling it.
    if (pen?.anchors.length === 1 && isOn(pen.anchors[0], e)) {
      pen.press = { kind: 'anchor', index: 0, added: false }
      return
    }
    if (pen && pen.anchors.length >= 2) {
      if (isOn(pen.anchors[0], e)) {
        pen.press = { kind: 'close' }
        return
      }
      if (isOn(pen.anchors[pen.anchors.length - 1], e)) {
        pen.press = { kind: 'end' }
        return
      }
    }
    const at = pen && e.shift ? snapAngle(lastPoint(pen), e.point) : e.point
    pen ??= { id: newNodeId(), style: store().shapeStyle, anchors: [], press: null }
    pen.anchors = [...pen.anchors, corner(at[0], at[1])]
    pen.press = { kind: 'anchor', index: pen.anchors.length - 1, added: true }
    store().setPenHover(null)
    showDraft(pen)
  },

  onMove(e) {
    if (pen?.press?.kind !== 'anchor') return
    const { index } = pen.press
    const anchor = pen.anchors[index]
    const to = e.shift ? snapAngle([anchor.x, anchor.y], e.point) : e.point
    const dx = to[0] - anchor.x
    const dy = to[1] - anchor.y
    const pulled = Math.hypot(dx, dy) * zoomOf(store()) >= DRAG_SLOP
    // The handles start out equal and opposite; as a smooth anchor they may differ later.
    const next = pulled
      ? {
          ...withHandle({ ...anchor, kind: 'symmetric' }, 'out', [dx, dy]),
          kind: 'smooth' as const,
        }
      : corner(anchor.x, anchor.y)
    pen.anchors = pen.anchors.map((a, i) => (i === index ? next : a))
    showDraft(pen)
  },

  onUp() {
    const press = pen?.press
    if (!pen || !press) return
    pen.press = null
    if (press.kind === 'close') finish(true, true)
    else if (press.kind === 'end') finish(false, true)
  },

  onHover(e) {
    if (!pen) {
      if (store().penHover) store().setPenHover(null)
      return
    }
    store().setPenHover(e && (e.shift ? snapAngle(lastPoint(pen), e.point) : e.point))
  },

  onKey(e) {
    if (!pen) return false
    const mod = e.ctrlKey || e.metaKey
    if (e.key === 'Enter' || e.key === 'Escape') finish(false, true)
    else if (
      (!mod && (e.key === 'Backspace' || e.key === 'Delete')) ||
      (mod && !e.shiftKey && e.key.toLowerCase() === 'z')
    ) {
      if (!pen.press) removeLastAnchor(pen)
    } else return false
    return true
  },

  // A pinch cancels the press that began it: the anchor it added goes, and the path goes on. A
  // switch to another tool ends the path, keeping what was drawn.
  onCancel() {
    if (!pen) return
    const press = pen.press
    pen.press = null
    if (press?.kind === 'anchor' && press.added) removeLastAnchor(pen)
    if (pen && store().tool !== 'pen') finish(false, false)
  },

  // A page switch or a file action ends the path open, keeping every anchor so far.
  onSettle() {
    if (pen) finish(false, false)
  },
}
