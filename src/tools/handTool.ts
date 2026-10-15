import { useEditorStore, zoomOf } from '../store/editorStore'
import type { ToolController } from './types'

const store = () => useEditorStore.getState()

// The canvas point under the pointer when the drag began.
let grab: [number, number] | null = null

/** Drag to pan. Panning moves the view, so the grabbed point stays under the pointer. */
export const handTool: ToolController = {
  cursor: 'grab',

  onDown(e) {
    grab = e.point
  },

  onMove(e) {
    if (!grab) return
    // Points are in canvas units at the current view; the view moves in screen pixels.
    const zoom = zoomOf(store())
    store().panBy((e.point[0] - grab[0]) * zoom, (e.point[1] - grab[1]) * zoom)
  },

  onUp() {
    grab = null
  },

  onCancel() {
    grab = null
  },
}
