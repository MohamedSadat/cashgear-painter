import { currentPageOf, useEditorStore, zoomOf } from '../../store/editorStore'
import type { NodeId } from '../../types'
import type { Box } from '../geometry/bounds'
import { GRID_SIZE, snapThreshold, type SnapTargets } from './snap'
import { collectTargets } from './targets'

// The store's side of snapping: what a drag on the canvas snaps to, and how close counts.

const store = () => useEditorStore.getState()

/** The part of the canvas on screen, in canvas units; null before the canvas is measured. */
function visibleArea(): Box | null {
  const state = store()
  const zoom = zoomOf(state)
  const { view, viewport } = state
  if (zoom <= 0 || viewport.width <= 0 || viewport.height <= 0) return null
  return {
    minX: -view.x / zoom,
    minY: -view.y / zoom,
    maxX: (viewport.width - view.x) / zoom,
    maxY: (viewport.height - view.y) / zoom,
  }
}

/**
 * The targets for a drag starting now on the current page, which moves the `dragged` nodes:
 * on-screen objects, the page, and the grid when it shows. Null when snapping is off or the
 * canvas isn't measured yet.
 */
export function beginSnap(dragged: readonly NodeId[]): SnapTargets | null {
  const state = store()
  if (!state.snapping || zoomOf(state) <= 0) return null
  return collectTargets(state.doc, currentPageOf(state).id, dragged, {
    area: visibleArea(),
    grid: state.grid ? GRID_SIZE : null,
  })
}

/** The snap distance at the current zoom, in canvas units: 6 screen pixels. */
export const currentThreshold = () => snapThreshold(zoomOf(store()))
