import { create } from 'zustand'
import type { Point, Stroke, Tool } from '../types'

export const HISTORY_LIMIT = 100
export const MIN_SIZE = 1
export const MAX_SIZE = 64

export interface PaintState {
  strokes: Stroke[]
  draft: Stroke | null // the stroke being drawn right now
  past: Stroke[][] // undo stack (snapshots)
  future: Stroke[][] // redo stack
  tool: Tool
  color: string
  size: number
  beginStroke(p: Point, pointerType: string): void
  extendStroke(p: Point): void
  endStroke(): void
  undo(): void
  redo(): void
  clear(): void
  setTool(t: Tool): void
  setColor(c: string): void
  setSize(n: number): void
}

// crypto.randomUUID() is missing on plain-http LAN URLs (npm run dev -- --host), so ids are built by hand.
let idCounter = 0
function newStrokeId(): string {
  idCounter += 1
  return `${Date.now().toString(36)}-${idCounter.toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function pushSnapshot(past: Stroke[][], strokes: Stroke[]): Stroke[][] {
  const next = [...past, strokes]
  return next.length > HISTORY_LIMIT ? next.slice(next.length - HISTORY_LIMIT) : next
}

export function clampSize(n: number): number {
  if (!Number.isFinite(n)) return MIN_SIZE
  return Math.min(MAX_SIZE, Math.max(MIN_SIZE, Math.round(n)))
}

export const usePaintStore = create<PaintState>()((set, get) => ({
  strokes: [],
  draft: null,
  past: [],
  future: [],
  tool: 'brush',
  color: '#000000',
  size: 8,

  beginStroke(p, pointerType) {
    const { tool, color, size } = get()
    set({
      draft: {
        id: newStrokeId(),
        tool,
        color,
        size,
        usesPressure: pointerType === 'pen',
        points: [p],
      },
    })
  },

  extendStroke(p) {
    const { draft } = get()
    if (!draft) return
    set({ draft: { ...draft, points: [...draft.points, p] } })
  },

  endStroke() {
    const { draft, strokes, past } = get()
    if (!draft) return
    set({
      strokes: [...strokes, draft],
      draft: null,
      past: pushSnapshot(past, strokes),
      future: [],
    })
  },

  undo() {
    const { past, strokes, future } = get()
    const previous = past.at(-1)
    if (!previous) return
    set({ strokes: previous, past: past.slice(0, -1), future: [...future, strokes] })
  },

  redo() {
    const { past, strokes, future } = get()
    const next = future.at(-1)
    if (!next) return
    set({ strokes: next, past: pushSnapshot(past, strokes), future: future.slice(0, -1) })
  },

  clear() {
    const { strokes, past } = get()
    if (strokes.length === 0) return
    set({ strokes: [], past: pushSnapshot(past, strokes), future: [] })
  },

  setTool(t) {
    set({ tool: t })
  },

  setColor(c) {
    set({ color: c })
  },

  setSize(n) {
    set({ size: clampSize(n) })
  },
}))
