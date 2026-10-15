import { useEffect, useState, type RefObject } from 'react'
import { CANVAS_HEIGHT, CANVAS_WIDTH } from '../types'

/** Largest scale at which the fixed-size canvas fits inside the element, keeping its aspect ratio. */
export function useFitScale(ref: RefObject<HTMLElement | null>): number {
  const [scale, setScale] = useState(0)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    // ResizeObserver also reports the initial size as soon as it starts observing.
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect
      setScale(Math.max(0, Math.min(width / CANVAS_WIDTH, height / CANVAS_HEIGHT)))
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [ref])

  return scale
}
