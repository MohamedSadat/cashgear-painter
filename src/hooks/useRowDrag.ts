import { useRef, type PointerEvent as ReactPointerEvent, type RefObject } from 'react'

// Pixels a press on a row must travel before it drags the row.
const DRAG_SLOP = 4
// Pixels from the list's edges where a drag scrolls it.
const SCROLL_EDGE = 24
const SCROLL_STEP = 8

type RowPointerEvent = ReactPointerEvent<HTMLElement>

interface RowDragOptions {
  listRef: RefObject<HTMLElement | null>
  axis: 'x' | 'y' // the way the list runs and scrolls
  blocked?: boolean // no drags start, such as while a row is being renamed
  // The pointer moved during a drag of row `id`.
  onMove(id: string, e: RowPointerEvent): void
  // The drag of row `id` ended: dropped at `e`, or null when cancelled.
  onEnd(id: string, e: RowPointerEvent | null): void
}

export interface RowDrag {
  onPointerDown(e: RowPointerEvent, id: string): void
  onPointerMove(e: RowPointerEvent): void
  onPointerUp(e: RowPointerEvent): void
  onPointerCancel(e: RowPointerEvent): void
  // True, once, for the click that follows a drag's release: it is part of the drag.
  takeClick(): boolean
}

/**
 * Dragging rows of a list to reorder them, as the layers and pages panels do: anywhere on a row
 * with a mouse or pen, by its `[data-grip]` with a finger, so the list still scrolls by touch. A
 * press becomes a drag after a few pixels and only then captures the pointer, so the row's
 * buttons still click; the list scrolls near its edges.
 */
export function useRowDrag({
  listRef,
  axis,
  blocked = false,
  onMove,
  onEnd,
}: RowDragOptions): RowDrag {
  const drag = useRef<{ pointerId: number; id: string; start: number; active: boolean } | null>(
    null,
  )
  const suppressClick = useRef(false)
  const along = (e: RowPointerEvent) => (axis === 'x' ? e.clientX : e.clientY)

  const end = (e: RowPointerEvent, drop: boolean) => {
    const current = drag.current
    if (!current || current.pointerId !== e.pointerId) return
    drag.current = null
    if (current.active) suppressClick.current = true
    onEnd(current.id, current.active && drop ? e : null)
  }

  return {
    onPointerDown(e, id) {
      suppressClick.current = false
      if (e.button !== 0 || blocked) return
      const target = e.target as HTMLElement
      const onGrip = target.closest('[data-grip]') !== null
      // Fingers drag only by the grip, so a swipe elsewhere scrolls the list.
      if (!onGrip && (e.pointerType === 'touch' || target.closest('input'))) return
      drag.current = { pointerId: e.pointerId, id, start: along(e), active: false }
    },

    onPointerMove(e) {
      const current = drag.current
      if (!current || current.pointerId !== e.pointerId) return
      if (!current.active) {
        if (Math.abs(along(e) - current.start) < DRAG_SLOP) return
        current.active = true
        // Captured only once it is a drag, so a click on the row's buttons stays a click.
        e.currentTarget.setPointerCapture(e.pointerId)
      }
      const list = listRef.current
      if (list) {
        const box = list.getBoundingClientRect()
        const [low, high] = axis === 'x' ? [box.left, box.right] : [box.top, box.bottom]
        const at = along(e)
        const step =
          at < low + SCROLL_EDGE ? -SCROLL_STEP : at > high - SCROLL_EDGE ? SCROLL_STEP : 0
        if (axis === 'x') list.scrollLeft += step
        else list.scrollTop += step
      }
      onMove(current.id, e)
    },

    onPointerUp(e) {
      end(e, true)
    },

    onPointerCancel(e) {
      end(e, false)
    },

    takeClick() {
      const suppressed = suppressClick.current
      suppressClick.current = false
      return suppressed
    },
  }
}
