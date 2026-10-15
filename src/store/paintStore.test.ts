import { beforeEach, describe, expect, it } from 'vitest'
import type { Point } from '../types'
import { HISTORY_LIMIT, MAX_SIZE, MIN_SIZE, usePaintStore } from './paintStore'

const initialState = usePaintStore.getState()
const store = () => usePaintStore.getState()
const point = (x: number, y: number, pressure = 0.5): Point => [x, y, pressure]

function drawStroke(x = 0, pointerType = 'mouse') {
  store().beginStroke(point(x, 0), pointerType)
  store().extendStroke(point(x + 10, 10))
  store().endStroke()
}

beforeEach(() => {
  usePaintStore.setState(initialState, true)
})

describe('drawing', () => {
  it('builds a draft from begin and extend, and commits it on end', () => {
    store().beginStroke(point(1, 2), 'mouse')
    store().extendStroke(point(3, 4))

    expect(store().draft?.points).toEqual([point(1, 2), point(3, 4)])
    expect(store().strokes).toEqual([])

    store().endStroke()

    expect(store().draft).toBeNull()
    expect(store().strokes).toHaveLength(1)
    expect(store().strokes[0].points).toEqual([point(1, 2), point(3, 4)])
  })

  it('takes tool, color and size from the current settings', () => {
    store().setTool('eraser')
    store().setColor('#ef4444')
    store().setSize(20)
    drawStroke()

    expect(store().strokes[0]).toMatchObject({ tool: 'eraser', color: '#ef4444', size: 20 })
  })

  it('uses real pressure only for pens', () => {
    drawStroke(0, 'mouse')
    drawStroke(0, 'touch')
    drawStroke(0, 'pen')

    expect(store().strokes.map((s) => s.usesPressure)).toEqual([false, false, true])
  })

  it('gives every stroke its own id', () => {
    drawStroke()
    drawStroke()

    const [a, b] = store().strokes
    expect(a.id).not.toBe(b.id)
  })

  it('ignores extend and end without a draft', () => {
    store().extendStroke(point(1, 1))
    store().endStroke()

    expect(store().strokes).toEqual([])
    expect(store().past).toEqual([])
  })
})

describe('history', () => {
  it('undoes and redoes strokes', () => {
    drawStroke(0)
    drawStroke(100)
    const [first, second] = store().strokes

    store().undo()
    expect(store().strokes).toEqual([first])

    store().redo()
    expect(store().strokes).toEqual([first, second])
  })

  it('reuses the same stroke objects across undo and redo', () => {
    drawStroke()
    const [stroke] = store().strokes

    store().undo()
    store().redo()

    expect(store().strokes[0]).toBe(stroke)
  })

  it('can undo a clear', () => {
    drawStroke(0)
    drawStroke(100)
    const before = store().strokes

    store().clear()
    expect(store().strokes).toEqual([])

    store().undo()
    expect(store().strokes).toBe(before)
  })

  it('can redo a clear', () => {
    drawStroke()
    store().clear()
    store().undo()
    store().redo()

    expect(store().strokes).toEqual([])
  })

  it('does not record a step when clearing an empty canvas', () => {
    store().clear()

    expect(store().past).toEqual([])
  })

  it('empties the redo stack when a new stroke is drawn', () => {
    drawStroke(0)
    drawStroke(100)
    store().undo()
    expect(store().future).toHaveLength(1)

    drawStroke(200)

    expect(store().future).toEqual([])
    store().redo()
    expect(store().strokes).toHaveLength(2)
  })

  it('keeps eraser strokes in history like any other stroke', () => {
    drawStroke(0)
    store().setTool('eraser')
    drawStroke(0)

    store().undo()
    expect(store().strokes.map((s) => s.tool)).toEqual(['brush'])

    store().redo()
    expect(store().strokes.map((s) => s.tool)).toEqual(['brush', 'eraser'])
  })

  it(`caps the undo stack at ${HISTORY_LIMIT} steps`, () => {
    for (let i = 0; i < HISTORY_LIMIT + 20; i++) drawStroke(i)

    expect(store().past).toHaveLength(HISTORY_LIMIT)

    for (let i = 0; i < HISTORY_LIMIT + 20; i++) store().undo()

    // The oldest 20 steps were dropped, so undo stops with 20 strokes left.
    expect(store().past).toEqual([])
    expect(store().strokes).toHaveLength(20)
  })

  it('does nothing when there is nothing to undo or redo', () => {
    store().undo()
    store().redo()

    expect(store().strokes).toEqual([])
    expect(store().past).toEqual([])
    expect(store().future).toEqual([])
  })
})

describe('settings', () => {
  it(`clamps size to ${MIN_SIZE}–${MAX_SIZE} whole units`, () => {
    store().setSize(0)
    expect(store().size).toBe(MIN_SIZE)

    store().setSize(500)
    expect(store().size).toBe(MAX_SIZE)

    store().setSize(12.6)
    expect(store().size).toBe(13)

    store().setSize(Number.NaN)
    expect(store().size).toBe(MIN_SIZE)
  })
})
