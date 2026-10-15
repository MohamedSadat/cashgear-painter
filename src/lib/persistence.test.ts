import { afterEach, describe, expect, it, vi } from 'vitest'
import { createStore } from 'zustand/vanilla'
import type { Stroke } from '../types'
import { SAVE_DELAY_MS, STORAGE_KEY, loadStrokes, saveStrokes, startAutosave } from './persistence'

function memoryStorage(): Storage {
  const data = new Map<string, string>()
  return {
    get length() {
      return data.size
    },
    clear: () => data.clear(),
    getItem: (key) => data.get(key) ?? null,
    key: (index) => [...data.keys()][index] ?? null,
    removeItem: (key) => {
      data.delete(key)
    },
    setItem: (key, value) => {
      data.set(key, String(value))
    },
  }
}

const stroke = (overrides: Partial<Stroke> = {}): Stroke => ({
  id: 's1',
  tool: 'brush',
  color: '#000000',
  size: 8,
  usesPressure: false,
  points: [
    [10.04, 20.06, 0.5],
    [30.15, 40.149, 0.5],
  ],
  ...overrides,
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('saveStrokes and loadStrokes', () => {
  it('round-trips strokes, rounding coordinates to 1 decimal', () => {
    const storage = memoryStorage()

    expect(saveStrokes([stroke({ points: [[10.04, 20.06, 0.123]] })], storage)).toBe(true)

    expect(loadStrokes(storage)).toEqual([stroke({ points: [[10, 20.1, 0.12]] })])
  })

  it('loads an empty canvas when nothing is saved', () => {
    expect(loadStrokes(memoryStorage())).toEqual([])
    expect(loadStrokes(null)).toEqual([])
  })

  it('loads an empty canvas from corrupt data', () => {
    const storage = memoryStorage()
    storage.setItem(STORAGE_KEY, '{not json')

    expect(loadStrokes(storage)).toEqual([])
  })

  it('drops malformed strokes and keeps the valid ones', () => {
    const storage = memoryStorage()
    const valid = stroke()
    storage.setItem(
      STORAGE_KEY,
      JSON.stringify([
        valid,
        { id: 'x' },
        stroke({ points: [] }),
        stroke({ tool: 'pencil' as 'brush' }),
      ]),
    )

    expect(loadStrokes(storage)).toEqual([valid])
  })

  it('reports a full quota instead of throwing', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const storage = memoryStorage()
    storage.setItem = () => {
      throw new DOMException('Quota exceeded', 'QuotaExceededError')
    }

    expect(saveStrokes([stroke()], storage)).toBe(false)
  })
})

describe('startAutosave', () => {
  it(`saves ${SAVE_DELAY_MS} ms after the strokes stop changing`, () => {
    vi.useFakeTimers()
    const storage = memoryStorage()
    const store = createStore<{ strokes: Stroke[] }>()(() => ({ strokes: [] }))
    const stop = startAutosave(store, storage)

    store.setState({ strokes: [stroke({ id: 'a' })] })
    vi.advanceTimersByTime(SAVE_DELAY_MS - 100)
    store.setState({ strokes: [stroke({ id: 'a' }), stroke({ id: 'b' })] })
    vi.advanceTimersByTime(SAVE_DELAY_MS - 1)
    expect(storage.getItem(STORAGE_KEY)).toBeNull()

    vi.advanceTimersByTime(1)
    expect(loadStrokes(storage).map((s) => s.id)).toEqual(['a', 'b'])

    stop()
  })

  it('stops saving once stopped', () => {
    vi.useFakeTimers()
    const storage = memoryStorage()
    const store = createStore<{ strokes: Stroke[] }>()(() => ({ strokes: [] }))
    const stop = startAutosave(store, storage)

    store.setState({ strokes: [stroke()] })
    stop()
    vi.advanceTimersByTime(SAVE_DELAY_MS * 2)

    expect(storage.getItem(STORAGE_KEY)).toBeNull()
  })
})
