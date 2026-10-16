import { TEXT_LINE_HEIGHT } from '../lib/geometry/textLayout'
import { createTextNode, isPickable, useEditorStore, zoomOf } from '../store/editorStore'
import type { NodeId } from '../types'
import type { ToolController } from './types'

const store = () => useEditorStore.getState()

type Xy = [number, number]

// Screen pixels a press must travel to set the width; a click places a text of the default width.
const DRAG_SLOP = 3
// A clicked text is this many font sizes wide; a dragged one at least this many canvas units.
const CLICK_WIDTH_EMS = 10
const MIN_WIDTH = 20

/**
 * Opens the textarea overlay on a text node. The whole edit is one gesture, so typing, and any
 * restyle on the way, is a single undo step.
 */
export function startTextEdit(id: NodeId): void {
  const { doc, editingText } = store()
  if (editingText === id) return
  if (editingText !== null) finishTextEdit()
  if (doc.nodes[id]?.type !== 'text' || !isPickable(doc, id)) return
  store().beginGesture()
  store().select([id])
  store().setEditingText(id)
}

/**
 * Closes the editor, keeping what was typed as one undo step. A text left empty is deleted: a new
 * one leaves no step at all. The text stays selected, and the text tool hands over to the select
 * tool, as the shape tools do.
 */
export function finishTextEdit(): void {
  const { editingText: id, doc, gestureStart } = store()
  if (id === null) return
  store().setEditingText(null)
  const node = doc.nodes[id]
  const isNew = gestureStart !== null && !(id in gestureStart.nodes)
  if (node?.type === 'text' && node.text.trim() === '') {
    if (isNew) store().cancelGesture()
    else {
      store().deleteNodes([id])
      store().endGesture()
    }
  } else store().endGesture()
  if (!(id in store().doc.nodes)) return
  store().select([id])
  if (store().tool === 'text') store().setTool('select')
}

/** Closes the editor and puts the text back as it was; a new text goes away. */
export function cancelTextEdit(): void {
  if (store().editingText === null) return
  store().setEditingText(null)
  store().cancelGesture()
}

let press: { start: Xy; target: NodeId | null; dragged: boolean } | null = null

/** The box a drag from `start` to `end` gives a new text: one line tall, centered on the press. */
function textBoxFrom(start: Xy, end: Xy, dragged: boolean) {
  const { fontSize } = store().textStyle
  const height = fontSize * TEXT_LINE_HEIGHT
  const width = dragged
    ? Math.max(MIN_WIDTH, Math.abs(end[0] - start[0]))
    : fontSize * CLICK_WIDTH_EMS
  const x = dragged ? Math.min(start[0], end[0]) : start[0]
  return { x, y: start[1] - height / 2, width, height }
}

/**
 * Text: a click places a text and a drag sets its width; typing happens in the textarea overlay
 * (TextEditor). A click on an existing text edits it. The width box shows while dragging.
 */
export const textTool: ToolController = {
  cursor: 'text',
  picksNodes: true,

  onDown(e) {
    press = { start: e.point, target: e.target, dragged: false }
  },

  onMove(e) {
    if (!press) return
    const { start } = press
    if (!press.dragged) {
      const travel = Math.hypot(e.point[0] - start[0], e.point[1] - start[1]) * zoomOf(store())
      if (travel < DRAG_SLOP) return
      press.dragged = true
    }
    store().setMarquee(textBoxFrom(start, e.point, true))
  },

  onUp(e) {
    const finished = press
    press = null
    if (!finished) return
    store().setMarquee(null)
    const { doc, textStyle } = store()
    const target = finished.target === null ? undefined : doc.nodes[finished.target]
    if (!finished.dragged && target?.type === 'text') {
      startTextEdit(target.id)
      return
    }
    const box = textBoxFrom(finished.start, e.point, finished.dragged)
    const node = createTextNode(box.x, box.y, box.width, textStyle)
    // Added inside the edit's gesture, so a text that ends up empty leaves no undo step.
    store().beginGesture()
    store().addNodes([node])
    store().select([node.id])
    store().setEditingText(node.id)
  },

  onCancel() {
    if (!press) return
    press = null
    store().setMarquee(null)
  },
}
