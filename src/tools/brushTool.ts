import { createStrokeNode, useEditorStore } from '../store/editorStore'
import type { Point } from '../types'
import type { ToolController, ToolEvent } from './types'

const store = () => useEditorStore.getState()
const toPoint = (e: ToolEvent): Point => [e.point[0], e.point[1], e.pressure]

/** Freehand strokes: the stroke grows as a draft and becomes a node, one undo step, on release. */
export const brushTool: ToolController = {
  cursor: 'crosshair',

  onDown(e) {
    const { color, size } = store().brush
    store().setDraft(
      createStrokeNode([toPoint(e)], { color, size, usesPressure: e.pointerType === 'pen' }),
    )
  },

  onMove(e) {
    const { draft } = store()
    if (draft?.type !== 'stroke') return
    store().setDraft({ ...draft, points: [...draft.points, toPoint(e)] })
  },

  onUp() {
    const { draft } = store()
    if (draft?.type !== 'stroke') return
    store().addNodes([draft])
    store().setDraft(null)
  },

  onCancel() {
    store().setDraft(null)
  },
}
