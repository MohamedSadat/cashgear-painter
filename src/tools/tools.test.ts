import { beforeEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_SHAPE_STYLE,
  createEllipseNode,
  createLineNode,
  createRectNode,
  createStrokeNode,
  useEditorStore,
  zoomOf,
} from '../store/editorStore'
import type { Point, StrokeNode } from '../types'
import { brushTool } from './brushTool'
import { eraserTool } from './eraserTool'
import { handTool } from './handTool'
import { selectTool } from './selectTool'
import { dragBox, ellipseTool, lineStyleOf, lineTool, rectTool } from './shapeTools'
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
  it('finds the select tool, the brush, the eraser, the shapes and the hand', () => {
    expect(toolFor('select')).toBe(selectTool)
    expect(toolFor('brush')).toBe(brushTool)
    expect(toolFor('eraser')).toBe(eraserTool)
    expect(toolFor('rect')).toBe(rectTool)
    expect(toolFor('ellipse')).toBe(ellipseTool)
    expect(toolFor('line')).toBe(lineTool)
    expect(toolFor('hand')).toBe(handTool)
    expect(toolFor('pen')).toBeUndefined()
  })
})

describe('dragBox', () => {
  it('spans the drag in any direction', () => {
    expect(dragBox([10, 20], [110, 70], {})).toEqual({ x: 10, y: 20, width: 100, height: 50 })
    expect(dragBox([110, 70], [10, 20], {})).toEqual({ x: 10, y: 20, width: 100, height: 50 })
  })

  it('makes a square toward the pointer, and centers on the start', () => {
    expect(dragBox([100, 100], [40, 130], { square: true })).toEqual({
      x: 40,
      y: 100,
      width: 60,
      height: 60,
    })
    expect(dragBox([100, 100], [130, 90], { fromCenter: true })).toEqual({
      x: 70,
      y: 90,
      width: 60,
      height: 20,
    })
    expect(dragBox([100, 100], [130, 90], { square: true, fromCenter: true })).toEqual({
      x: 70,
      y: 70,
      width: 60,
      height: 60,
    })
  })

  it('keeps sides at least the minimum', () => {
    expect(dragBox([10, 20], [110, 20], {}, 1)).toEqual({ x: 10, y: 20, width: 100, height: 1 })
  })
})

describe('shape tools', () => {
  // At zoom 1, canvas units are screen pixels.
  beforeEach(() => {
    store().setViewport({ width: 1000, height: 700, fit: 1 })
    store().setTool('rect')
  })

  const mods = (x: number, y: number, shift = false, alt = false): ToolEvent => ({
    ...at(x, y),
    shift,
    alt,
  })

  it('draws a rectangle as a draft, then commits it as one step, selected, with the select tool', () => {
    store().setShapeStyle({ fill: '#22c55e' })

    rectTool.onDown(at(10, 20))
    rectTool.onMove(at(60, 40))
    expect(store().draft).toMatchObject({ type: 'rect', width: 50, height: 20 })
    expect(store().doc.rootIds).toEqual([])
    rectTool.onUp(at(110, 70))

    expect(store().draft).toBeNull()
    expect(store().past).toHaveLength(1)
    const [id] = store().doc.rootIds
    expect(store().doc.nodes[id]).toMatchObject({
      type: 'rect',
      transform: { x: 10, y: 20, rotation: 0, scaleX: 1, scaleY: 1 },
      width: 100,
      height: 50,
      cornerRadius: 0,
      style: { ...DEFAULT_SHAPE_STYLE, fill: '#22c55e' },
    })
    expect(store().selection).toEqual([id])
    expect(store().tool).toBe('select')

    store().undo()
    expect(store().doc.rootIds).toEqual([])
    expect(store().selection).toEqual([])
  })

  it('reads Shift and Alt as the pointer moves', () => {
    rectTool.onDown(at(100, 100))
    rectTool.onMove(mods(140, 120, true))
    expect(store().draft).toMatchObject({ width: 40, height: 40 })
    rectTool.onUp(mods(140, 120, false, true))

    const [id] = store().doc.rootIds
    expect(store().doc.nodes[id]).toMatchObject({
      transform: { x: 60, y: 80 },
      width: 80,
      height: 40,
    })
  })

  it('draws an ellipse around its center; Shift makes a circle', () => {
    ellipseTool.onDown(at(100, 100))
    ellipseTool.onUp(mods(160, 120, true))

    const [id] = store().doc.rootIds
    expect(store().doc.nodes[id]).toMatchObject({
      type: 'ellipse',
      transform: { x: 130, y: 130 },
      rx: 30,
      ry: 30,
    })
  })

  it('draws a line from its start; Shift snaps it to 45°', () => {
    lineTool.onDown(at(100, 100))
    lineTool.onUp(at(200, 150))
    lineTool.onDown(at(100, 100))
    lineTool.onUp(mods(200, 105, true))

    const [line, snapped] = store().doc.rootIds.map((id) => store().doc.nodes[id])
    expect(line).toMatchObject({
      type: 'line',
      transform: { x: 100, y: 100 },
      points: [0, 0, 100, 50],
      arrowStart: false,
      arrowEnd: false,
    })
    expect(snapped.type === 'line' && snapped.points[3]).toBe(0)
  })

  it('gives a line an outline even when new shapes have none', () => {
    store().setShapeStyle({ stroke: null, fill: '#ef4444' })

    lineTool.onDown(at(0, 0))
    lineTool.onUp(at(100, 0))

    const [id] = store().doc.rootIds
    expect(store().doc.nodes[id].style).toMatchObject({ fill: null, stroke: '#000000' })
    expect(lineStyleOf(store().shapeStyle).stroke).toBe('#000000')
  })

  it('draws nothing for a click, and keeps a level drag at least 1 unit tall', () => {
    rectTool.onDown(at(100, 100))
    rectTool.onUp(at(101, 101))
    expect(store().doc.rootIds).toEqual([])
    expect(store().past).toEqual([])
    expect(store().tool).toBe('rect')

    rectTool.onDown(at(100, 100))
    rectTool.onUp(at(200, 100))
    const [id] = store().doc.rootIds
    expect(store().doc.nodes[id]).toMatchObject({ width: 100, height: 1 })
  })

  it('measures the click slop on screen, so a tiny drag at high zoom still draws', () => {
    store().zoomTo(32)

    rectTool.onDown(at(100, 100))
    rectTool.onUp(at(100.5, 100.5))

    expect(store().doc.rootIds).toHaveLength(1)
  })

  it('drops the draft on cancel', () => {
    rectTool.onDown(at(0, 0))
    rectTool.onMove(at(50, 50))
    rectTool.onCancel?.()
    rectTool.onUp(at(50, 50))

    expect(store().draft).toBeNull()
    expect(store().doc.rootIds).toEqual([])
    expect(store().tool).toBe('rect')
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

  it('erases shapes it touches, and unfilled ones only on their outline', () => {
    const box = { x: 0, y: 0, width: 200, height: 100 }
    const empty = createRectNode(box, DEFAULT_SHAPE_STYLE)
    const solid = createEllipseNode(
      { ...box, x: 300 },
      { ...DEFAULT_SHAPE_STYLE, fill: '#ef4444', stroke: null },
    )
    const arrow = createLineNode([0, 300], [200, 300], DEFAULT_SHAPE_STYLE)
    store().addNodes([empty, solid, arrow])
    store().setBrush({ size: 10 })
    const erase = (from: [number, number], to: [number, number]) => {
      eraserTool.onDown(at(...from))
      eraserTool.onMove(at(...to))
      eraserTool.onUp(at(...to))
    }

    erase([100, 50], [120, 60]) // inside the empty rectangle
    expect(store().doc.rootIds).toEqual([empty.id, solid.id, arrow.id])
    erase([400, 50], [410, 50]) // inside the solid ellipse
    erase([100, 250], [100, 350]) // across the line
    expect(store().doc.rootIds).toEqual([empty.id])
    erase([100, -3], [120, -3]) // along the rectangle's top edge
    expect(store().doc.rootIds).toEqual([])
    expect(store().past).toHaveLength(4)
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

  it('selects shapes the marquee fully covers, outlines included', () => {
    const rect = createRectNode({ x: 0, y: 0, width: 100, height: 50 }, DEFAULT_SHAPE_STYLE)
    const ellipse = createEllipseNode({ x: 200, y: 0, width: 100, height: 50 }, DEFAULT_SHAPE_STYLE)
    const line = createLineNode([0, 200], [100, 200], DEFAULT_SHAPE_STYLE)
    store().addNodes([rect, ellipse, line])

    // Reaches the rectangle's edge but not its outline, which sticks out 2 units.
    drag(on(-1, -1), [101, 51])
    expect(store().selection).toEqual([])
    drag(on(-3, -3), [303, 53])
    expect(store().selection).toEqual([rect.id, ellipse.id])
    drag(on(-3, 190), [103, 210])
    expect(store().selection).toEqual([line.id])
  })

  it('moves a shape dragged inside the selection box, even through an empty middle', () => {
    const rect = createRectNode({ x: 0, y: 0, width: 100, height: 50 }, DEFAULT_SHAPE_STYLE)
    store().addNodes([rect])
    store().select([rect.id])

    drag(on(50, 25), [70, 45])

    expect(transformOf(rect.id)).toMatchObject({ x: 20, y: 20 })
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
