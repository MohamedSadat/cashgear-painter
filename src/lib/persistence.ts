import type { Point, Stroke } from '../types'

export const STORAGE_KEY = 'painter:v1'
export const SAVE_DELAY_MS = 500

interface StrokeState {
  strokes: Stroke[]
}

interface StrokeStore {
  getState(): StrokeState
  subscribe(listener: (state: StrokeState, previous: StrokeState) => void): () => void
}

function defaultStorage(): Storage | null {
  // Reading localStorage itself throws when site data is blocked.
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null
  }
}

const round = (n: number, digits: number) => {
  const factor = 10 ** digits
  return Math.round(n * factor) / factor
}

// Rounding keeps a busy drawing well under the ~5 MB localStorage quota.
function compact(stroke: Stroke): Stroke {
  return {
    ...stroke,
    points: stroke.points.map(([x, y, pressure]): Point => [
      round(x, 1),
      round(y, 1),
      round(pressure, 2),
    ]),
  }
}

function isPoint(value: unknown): value is Point {
  return (
    Array.isArray(value) &&
    value.length === 3 &&
    value.every((n) => typeof n === 'number' && Number.isFinite(n))
  )
}

function isStroke(value: unknown): value is Stroke {
  if (typeof value !== 'object' || value === null) return false
  const s = value as Record<string, unknown>
  return (
    typeof s.id === 'string' &&
    (s.tool === 'brush' || s.tool === 'eraser') &&
    typeof s.color === 'string' &&
    typeof s.size === 'number' &&
    Number.isFinite(s.size) &&
    typeof s.usesPressure === 'boolean' &&
    Array.isArray(s.points) &&
    s.points.length > 0 &&
    s.points.every(isPoint)
  )
}

/** Strokes saved by a previous visit; anything missing or malformed loads as an empty canvas. */
export function loadStrokes(storage: Storage | null = defaultStorage()): Stroke[] {
  try {
    const raw = storage?.getItem(STORAGE_KEY)
    if (!raw) return []
    const data: unknown = JSON.parse(raw)
    return Array.isArray(data) ? data.filter(isStroke) : []
  } catch {
    return []
  }
}

/** Returns false when the write failed, for example because the quota is full. */
export function saveStrokes(
  strokes: Stroke[],
  storage: Storage | null = defaultStorage(),
): boolean {
  if (!storage) return false
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(strokes.map(compact)))
    return true
  } catch (error) {
    console.warn('Autosave failed', error)
    return false
  }
}

/**
 * Saves the strokes 500 ms after they stop changing, and right away when the page is hidden
 * (a refresh, tab switch or app switch). Returns a function that stops autosaving.
 */
export function startAutosave(
  store: StrokeStore,
  storage: Storage | null = defaultStorage(),
): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined

  const flush = () => {
    if (timer === undefined) return
    clearTimeout(timer)
    timer = undefined
    saveStrokes(store.getState().strokes, storage)
  }

  const unsubscribe = store.subscribe((state, previous) => {
    if (state.strokes === previous.strokes) return
    clearTimeout(timer)
    timer = setTimeout(flush, SAVE_DELAY_MS)
  })

  const onVisibilityChange = () => {
    if (document.visibilityState === 'hidden') flush()
  }
  const hasWindow = typeof window !== 'undefined'
  if (hasWindow) {
    window.addEventListener('pagehide', flush)
    document.addEventListener('visibilitychange', onVisibilityChange)
  }

  return () => {
    clearTimeout(timer)
    unsubscribe()
    if (hasWindow) {
      window.removeEventListener('pagehide', flush)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }
}
