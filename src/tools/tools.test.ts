import { beforeEach, describe, expect, it } from 'vitest'
import { createStrokeNode, useEditorStore, zoomOf } from '../store/editorStore'
import type { Point, StrokeNode } from '../types'
import { brushTool } from './brushTool'
import { eraserTool } from './eraserTool'
import { handTool } from './handTool'
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
  it('finds the brush, the eraser and the hand', () => {
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
