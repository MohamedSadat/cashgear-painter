import { beforeEach, describe, expect, it } from 'vitest'
import { createStrokeNode, useEditorStore, zoomOf } from '../store/editorStore'
import type { Point, StrokeNode } from '../types'
import { brushTool } from './brushTool'
import { eraserTool } from './eraserTool'
import { handTool } from './handTool'
import { selectTool } from './selectTool'
import { toolFor } from './index'
import type { ToolEvent } from './types'

const initialState = useEditorStore.getState()
const store = () => useEditorStore.getState()

const at = (x: number, y: number, pointerType = 'mouse', pressure = 0.5): ToolEvent => ({
  point: [x, y],
  pressure,
  pointerType,
  shift: false,
  alt: false,
  mod: false,
  target: null,
})

/** A size-8 horizontal stroke along y from x = 0 to 100, added as its own history step. */
function addLine(y: number, overrides: Partial<StrokeNode> = {}): StrokeNode {
  const points: Point[] = [
    [0, y, 0.5],
    [100, y, 0.5],
  ]
  const node = {
    ...createStrokeNode(points, { color: '#000000', size: 8, usesPressure: false }),
    ...overrides,
  }
  store().addNodes([node])
  return node
}

beforeEach(() => {
  useEditorStore.setState(initialState, true)
})

describe('toolFor', () => {
  it('finds the select tool, the brush, the eraser and the hand', () => {
    expect(toolFor('select')).toBe(selectTool)
    expect(toolFor('brush')).toBe(brushTool)
    expect(toolFor('eraser')).toBe(eraserTool)
    expect(toolFor('hand')).toBe(handTool)
    expect(toolFor('pen')).toBeUndefined()
  })
})

describe('brushTool', () => {
  it('draws a draft and commits it as one node in one step', () => {
    store().setBrush({ color: '#ef4444', size: 20 })

    brushTool.onDown(at(1, 2))
    brushTool.onMove(at(3, 4))
    expect(store().draft).toMatchObject({
      type: 'stroke',
      points: [
        [1, 2, 0.5],
        [3, 4, 0.5],
      ],
    })
    expect(store().doc.rootIds).toEqual([])

    brushTool.onUp(at(3, 4))

    expect(store().draft).toBeNull()
    expect(store().past).toHaveLength(1)
    const [id] = store().doc.rootIds
    expect(store().doc.nodes[id]).toMatchObject({
      type: 'stroke',
      size: 20,
      style: { fill: '#ef4444' },
      usesPressure: false,
    })
  })

  it('uses real pressure only for pens', () => {
    for (const pointerType of ['mouse', 'touch', 'pen']) {
      brushTool.onDown(at(0, 0, pointerType))
      brushTool.onUp(at(0, 0, pointerType))
    }

    const nodes = store().doc.rootIds.map((id) => store().doc.nodes[id] as StrokeNode)
    expect(nodes.map((n) => n.usesPressure)).toEqual([false, false, true])
    expect(new Set(store().doc.rootIds).size).toBe(3)
  })

  it('drops the draft on cancel', () => {
    brushTool.onDown(at(0, 0))
    brushTool.onCancel?.()
    brushTool.onUp(at(0, 0))

    expect(store().draft).toBeNull()
    expect(store().doc.rootIds).toEqual([])
    expect(store().past).toEqual([])
  })
})

describe('eraserTool', () => {
  it('dims touched nodes while erasing and deletes them in one step on release', () => {
    const top = addLine(0)
    const bottom = addLine(100)
    store().setBrush({ size: 10 })

    eraserTool.onDown(at(50, -40))
    eraserTool.onMove(at(50, 40)) // a fast swipe across the top line only
    expect(store().erasing).toEqual([top.id])
    expect(store().doc.rootIds).toHaveLength(2)

    eraserTool.onUp(at(50, 40))

    expect(store().erasing).toEqual([])
    expect(store().doc.rootIds).toEqual([bottom.id])
    expect(store().past).toHaveLength(3)

    store().undo()
    expect(store().doc.rootIds).toEqual([top.id, bottom.id])
  })

  it('skips hidden and locked nodes', () => {
    addLine(0, { hidden: true })
    addLine(0, { locked: true })

    eraserTool.onDown(at(50, 0))
    eraserTool.onUp(at(50, 0))

    expect(store().doc.rootIds).toHaveLength(2)
    expect(store().past).toHaveLength(2)
  })

  it('records nothing when it touches nothing', () => {
    addLine(0)

    eraserTool.onDown(at(50, 300))
    eraserTool.onUp(at(50, 300))

    expect(store().past).toHaveLength(1)
  })

  it('deletes nothing on cancel', () => {
    addLine(0)

    eraserTool.onDown(at(50, 0))
    eraserTool.onCancel?.()
    eraserTool.onUp(at(50, 0))

    expect(store().erasing).toEqual([])
    expect(store().doc.rootIds).toHaveLength(1)
  })
})

describe('handTool', () => {
  beforeEach(() => {
    store().setViewport({ width: 1000, height: 700, fit: 0.5 })
    store().zoomTo(2)
  })

  it('pans by the screen distance the pointer moved, outside history', () => {
    const before = store().view
    expect(zoomOf(store())).toBe(2)

    handTool.onDown(at(100, 100))
    // Canvas points are read at the view before the move, so 10 units are 20 screen pixels.
    handTool.onMove(at(110, 95))

    expect(store().view.scale).toBe(before.scale)
    expect(store().view.x).toBeCloseTo(before.x + 20, 9)
    expect(store().view.y).toBeCloseTo(before.y - 10, 9)
    expect(store().past).toEqual([])
  })

  it('stops panning on release and on cancel', () => {
    const before = store().view

    handTool.onDown(at(0, 0))
    handTool.onUp(at(0, 0))
    handTool.onMove(at(50, 50))
    handTool.onDown(at(0, 0))
    handTool.onCancel?.()
    handTool.onMove(at(50, 50))

    expect(store().view).toEqual(before)
  })
})

describe('selectTool', () => {
  // At zoom 1, canvas units are screen pixels.
  beforeEach(() => {
    selectTool.onCancel?.()
    store().setViewport({ width: 1000, height: 700, fit: 1 })
  })

  const on = (x: number, y: number, target: string | null = null, shift = false): ToolEvent => ({
    ...at(x, y),
    target,
    shift,
  })

  function click(e: ToolEvent) {
    selectTool.onDown(e)
    selectTool.onUp(e)
  }

  function drag(from: ToolEvent, ...to: [number, number][]) {
    selectTool.onDown(from)
    for (const [x, y] of to) selectTool.onMove(on(x, y, null, from.shift))
    selectTool.onUp(on(...to[to.length - 1]))
  }

  const key = (k: string, mods: Partial<KeyboardEvent> = {}) =>
    ({
      key: k,
      code: '',
      shiftKey: false,
      ctrlKey: false,
      metaKey: false,
      altKey: false,
      ...mods,
    }) as KeyboardEvent

  const transformOf = (id: string) => store().doc.nodes[id].transform

  it('selects on click, adds with Shift, and Shift-click on a selected node removes it', () => {
    const a = addLine(0)
    const b = addLine(100)

    click(on(50, 0, a.id))
    expect(store().selection).toEqual([a.id])
    click(on(50, 100, b.id, true))
    expect(store().selection).toEqual([a.id, b.id])
    click(on(50, 0, a.id, true))
    expect(store().selection).toEqual([b.id])
    click(on(50, 0, a.id))
    expect(store().selection).toEqual([a.id])
  })

  it('keeps only the clicked node of a bigger selection, and clears on empty canvas', () => {
    const a = addLine(0)
    const b = addLine(100)
    store().select([a.id, b.id])

    click(on(50, 0, a.id))
    expect(store().selection).toEqual([a.id])
    click(on(500, 500))
    expect(store().selection).toEqual([])
  })

  it('moves the selection as one undo step', () => {
    const a = addLine(0)
    const b = addLine(100)
    store().select([a.id, b.id])

    drag(on(50, 0, a.id), [60, 5], [80, 20])

    expect(transformOf(a.id)).toMatchObject({ x: 30, y: 20 })
    expect(transformOf(b.id)).toMatchObject({ x: 30, y: 20 })
    expect(store().past).toHaveLength(3)
    expect(store().selection).toEqual([a.id, b.id])

    store().undo()
    expect(transformOf(a.id)).toMatchObject({ x: 0, y: 0 })
  })

  it('drags the inside of the selection box, between its nodes', () => {
    const a = addLine(0)
    const b = addLine(100)
    store().select([a.id, b.id])

    drag(on(50, 50), [50, 60])

    expect(transformOf(a.id).y).toBe(10)
    expect(transformOf(b.id).y).toBe(10)
  })

  it('ignores a press that moves less than the drag slop', () => {
    const a = addLine(0)

    drag(on(50, 0, a.id), [52, 1])

    expect(transformOf(a.id)).toMatchObject({ x: 0, y: 0 })
    expect(store().past).toHaveLength(1)
    expect(store().selection).toEqual([a.id])
  })

  it('selects what the marquee fully covers, and Shift adds to the selection', () => {
    const a = addLine(0)
    const b = addLine(100)

    selectTool.onDown(on(-10, -10))
    selectTool.onMove(on(110, 20))
    expect(store().marquee).toEqual({ x: -10, y: -10, width: 120, height: 30 })
    expect(store().selection).toEqual([a.id])
    selectTool.onUp(on(110, 20))
    expect(store().marquee).toBeNull()

    store().select([b.id])
    drag(on(-10, -10, null, true), [110, 20])
    expect(store().selection).toEqual([b.id, a.id])
    expect(store().past).toHaveLength(2)
  })

  it('Esc puts a moving selection back, then clears the selection', () => {
    const a = addLine(0)

    selectTool.onDown(on(50, 0, a.id))
    selectTool.onMove(on(90, 40))
    expect(selectTool.onKey?.(key('Escape'))).toBe(true)
    selectTool.onMove(on(120, 40))
    selectTool.onUp(on(120, 40))

    expect(transformOf(a.id)).toMatchObject({ x: 0, y: 0 })
    expect(store().gestureStart).toBeNull()
    expect(store().past).toHaveLength(1)

    expect(selectTool.onKey?.(key('Escape'))).toBe(true)
    expect(store().selection).toEqual([])
    expect(selectTool.onKey?.(key('Escape'))).toBe(false)
  })

  it('nudges, reorders, duplicates and deletes the selection from the keyboard', () => {
    const a = addLine(0)
    const b = addLine(100)
    store().select([a.id])

    selectTool.onKey?.(key('ArrowRight', { shiftKey: true }))
    selectTool.onKey?.(key('ArrowDown'))
    expect(transformOf(a.id)).toMatchObject({ x: 10, y: 1 })

    selectTool.onKey?.(key(']', { ctrlKey: true, code: 'BracketRight' }))
    expect(store().doc.rootIds).toEqual([b.id, a.id])
    selectTool.onKey?.(key('[', { metaKey: true, code: 'BracketLeft' }))
    expect(store().doc.rootIds).toEqual([a.id, b.id])
    selectTool.onKey?.(key('}', { ctrlKey: true, shiftKey: true, code: 'BracketRight' }))
    expect(store().doc.rootIds).toEqual([b.id, a.id])

    selectTool.onKey?.(key('d', { ctrlKey: true }))
    expect(store().doc.rootIds).toHaveLength(3)
    const [copyId] = store().selection
    expect(copyId).not.toBe(a.id)

    selectTool.onKey?.(key('Delete'))
    expect(store().doc.rootIds).toEqual([b.id, a.id])
    expect(store().selection).toEqual([])
    expect(selectTool.onKey?.(key('Delete'))).toBe(false)
  })

  it('cuts and copies to the clipboard', () => {
    const a = addLine(0)
    store().select([a.id])

    selectTool.onKey?.(key('c', { ctrlKey: true }))
    expect(store().doc.rootIds).toEqual([a.id])
    selectTool.onKey?.(key('x', { ctrlKey: true }))
    expect(store().doc.rootIds).toEqual([])

    store().paste()
    expect(store().doc.rootIds).toHaveLength(1)
    expect(store().clipboard.map((n) => n.id)).toEqual([a.id])
  })
})
