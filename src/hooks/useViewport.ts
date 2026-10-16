import { useEffect, useLayoutEffect, useState, type RefObject } from 'react'
import { clampZoom, useEditorStore, zoomOf } from '../store/editorStore'
import type { ToolId } from '../types'
import { isTextEntry } from './useShortcuts'

// A second finger starts a pinch only while the first has moved less than this, in screen pixels.
const PINCH_SLOP = 8
// Firefox reports wheel deltas in lines.
const LINE_HEIGHT = 16
// Caps one mouse-wheel notch at about a third more or less zoom; trackpad pinches send small deltas.
const MAX_ZOOM_DELTA = 30

const store = () => useEditorStore.getState()

interface TouchTrack {
  start: [number, number]
  current: [number, number]
  moved: boolean // went further than PINCH_SLOP from where it landed
}

interface Pinch {
  ids: [number, number]
  zoom: number // when the pinch began
  distance: number
  anchor: [number, number] // canvas point under the midpoint of the two fingers
}

const midpoint = (a: [number, number], b: [number, number]): [number, number] => [
  (a[0] + b[0]) / 2,
  (a[1] + b[1]) / 2,
]
const distance = (a: [number, number], b: [number, number]) => Math.hypot(a[0] - b[0], a[1] - b[1])

/**
 * Zoom and pan for the canvas area `ref`, which the Stage fills. Measures the area into the store,
 * which fits the current page to the box inside its padding,
 * zooms on Ctrl/Cmd + wheel (and trackpad pinch) around the pointer, pans on plain wheel, pinches
 * and pans with two fingers, and holds the hand tool while Space is down. `onPinchStart` must cancel
 * whatever the first finger started, since a pinch is not a stroke.
 */
export function useViewport(ref: RefObject<HTMLElement | null>, onPinchStart: () => void): void {
  const [size, setSize] = useState({ width: 0, height: 0, boxWidth: 0, boxHeight: 0 })

  useEffect(() => {
    const el = ref.current
    if (!el) return
    // The Stage covers the padding too; the page fits the content box inside it. ResizeObserver
    // also reports the first size as soon as it starts observing.
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect
      setSize({
        width: el.clientWidth,
        height: el.clientHeight,
        boxWidth: Math.max(0, width),
        boxHeight: Math.max(0, height),
      })
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [ref])

  useLayoutEffect(() => {
    store().setViewport(size)
  }, [size])

  // Wheel: zoom with Ctrl/Cmd (trackpad pinches arrive as Ctrl + wheel), pan otherwise.
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const onWheel = (evt: WheelEvent) => {
      // Not passive, so Ctrl + wheel can't zoom the page instead.
      evt.preventDefault()
      const unit =
        evt.deltaMode === WheelEvent.DOM_DELTA_LINE
          ? LINE_HEIGHT
          : evt.deltaMode === WheelEvent.DOM_DELTA_PAGE
            ? el.clientHeight
            : 1
      let dx = evt.deltaX * unit
      let dy = evt.deltaY * unit
      if (evt.ctrlKey || evt.metaKey) {
        const rect = el.getBoundingClientRect()
        const step = Math.max(-MAX_ZOOM_DELTA, Math.min(MAX_ZOOM_DELTA, dy))
        store().zoomTo(zoomOf(store()) * Math.exp(-step / 100), [
          evt.clientX - rect.left,
          evt.clientY - rect.top,
        ])
        return
      }
      // A mouse wheel with Shift held scrolls sideways.
      if (evt.shiftKey && dx === 0) [dx, dy] = [dy, 0]
      store().panBy(-dx, -dy)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [ref])

  // Two fingers pinch-zoom and pan together.
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const touches = new Map<number, TouchTrack>()
    let pinch: Pinch | null = null

    const local = (evt: PointerEvent): [number, number] => {
      const rect = el.getBoundingClientRect()
      return [evt.clientX - rect.left, evt.clientY - rect.top]
    }

    const onDown = (evt: PointerEvent) => {
      if (evt.pointerType !== 'touch') return
      const at = local(evt)
      touches.set(evt.pointerId, { start: at, current: at, moved: false })
      if (touches.size !== 2 || pinch) return
      const [[firstId, first]] = touches
      // Once the first finger has drawn a little, a second one is just a resting finger.
      if (first.moved) return
      onPinchStart()
      const state = store()
      const zoom = zoomOf(state)
      const center = midpoint(first.current, at)
      pinch = {
        ids: [firstId, evt.pointerId],
        zoom,
        distance: Math.max(1, distance(first.current, at)),
        anchor: [(center[0] - state.view.x) / zoom, (center[1] - state.view.y) / zoom],
      }
    }

    const onMove = (evt: PointerEvent) => {
      const touch = touches.get(evt.pointerId)
      if (!touch) return
      touch.current = local(evt)
      if (distance(touch.start, touch.current) >= PINCH_SLOP) touch.moved = true
      if (!pinch?.ids.includes(evt.pointerId)) return
      const a = touches.get(pinch.ids[0])
      const b = touches.get(pinch.ids[1])
      if (!a || !b) return
      const center = midpoint(a.current, b.current)
      const zoom = clampZoom((pinch.zoom * distance(a.current, b.current)) / pinch.distance)
      store().setView({
        scale: zoom / store().viewport.fit,
        x: center[0] - pinch.anchor[0] * zoom,
        y: center[1] - pinch.anchor[1] * zoom,
      })
    }

    const onUp = (evt: PointerEvent) => {
      if (!touches.delete(evt.pointerId)) return
      if (pinch?.ids.includes(evt.pointerId)) pinch = null
    }

    el.addEventListener('pointerdown', onDown)
    el.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    return () => {
      el.removeEventListener('pointerdown', onDown)
      el.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
    }
  }, [ref, onPinchStart])

  // Holding Space switches to the hand tool, and letting go switches back.
  useEffect(() => {
    let heldFrom: ToolId | null = null
    const release = () => {
      if (heldFrom === null) return
      if (store().tool === 'hand') store().setTool(heldFrom)
      heldFrom = null
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== ' ' || isTextEntry(e.target)) return
      // Also keeps Space from pressing a focused toolbar button.
      e.preventDefault()
      if (e.repeat || heldFrom !== null || store().tool === 'hand') return
      heldFrom = store().tool
      store().setTool('hand')
    }
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key !== ' ') return
      if (!isTextEntry(e.target)) e.preventDefault()
      release()
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', release)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', release)
    }
  }, [])
}
