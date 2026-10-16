import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_SHAPE_STYLE,
  DEFAULT_TEXT_STYLE,
  createEllipseNode,
  createLineNode,
  createPathNode,
  createRectNode,
  createStrokeNode,
  createTextNode,
  useEditorStore,
  zoomOf,
} from '../store/editorStore'
import { solid } from '../lib/paint/paint'
import type { Anchor, GroupNode, PathNode, Point, StrokeNode, TextNode } from '../types'
import { brushTool } from './brushTool'
import {
  deleteActiveAnchor,
  directTool,
  moveAnchorTo,
  moveHandleTo,
  setActiveAnchorKind,
} from './directTool'
import { eraserTool } from './eraserTool'
import { handTool } from './handTool'
import { finishPath, penTool } from './penTool'
import { selectTool } from './selectTool'
import { dragBox, ellipseTool, lineStyleOf, lineTool, rectTool } from './shapeTools'
import { cancelTextEdit, finishTextEdit, startTextEdit, textTool } from './textTool'
import { toolFor } from './index'
import type { ToolEvent } from './types'

const initialState = useEditorStore.getState()
const store = () => useEditorStore.getState()

// The time pointer events carry, in ms. It stands still unless a test waits, so presses in a test
// are at the same moment; each test starts a second after the last.
let clock = 0
const wait = (ms: number) => {
  clock += ms
}

const at = (x: number, y: number, pointerType = 'mouse', pressure = 0.5): ToolEvent => ({
  point: [x, y],
  pressure,
  pointerType,
  shift: false,
  alt: false,
  mod: false,
  target: null,
  timeStamp: clock,
})

/** A measured canvas area whose box fits the 1600 × 1000 first page at `fit`. */
const measured = (width: number, height: number, fit: number) => ({
  width,
  height,
  boxWidth: 1600 * fit,
  boxHeight: 1000 * fit,
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
  wait(1000)
})

describe('toolFor', () => {
  it('finds every tool', () => {
    expect(toolFor('select')).toBe(selectTool)
    expect(toolFor('direct')).toBe(directTool)
    expect(toolFor('brush')).toBe(brushTool)
    expect(toolFor('eraser')).toBe(eraserTool)
    expect(toolFor('rect')).toBe(rectTool)
    expect(toolFor('ellipse')).toBe(ellipseTool)
    expect(toolFor('line')).toBe(lineTool)
    expect(toolFor('hand')).toBe(handTool)
    expect(toolFor('pen')).toBe(penTool)
    expect(toolFor('text')).toBe(textTool)
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
    store().setViewport(measured(1000, 700, 1))
    store().setTool('rect')
  })

  const mods = (x: number, y: number, shift = false, alt = false): ToolEvent => ({
    ...at(x, y),
    shift,
    alt,
  })

  it('draws a rectangle as a draft, then commits it as one step, selected, with the select tool', () => {
    store().setShapeStyle({ fill: solid('#22c55e') })

    rectTool.onDown(at(10, 20))
    rectTool.onMove(at(60, 40))
    expect(store().draft).toMatchObject({ type: 'rect', width: 50, height: 20 })
    expect(store().doc.pages[0].rootIds).toEqual([])
    rectTool.onUp(at(110, 70))

    expect(store().draft).toBeNull()
    expect(store().past).toHaveLength(1)
    const [id] = store().doc.pages[0].rootIds
    expect(store().doc.nodes[id]).toMatchObject({
      type: 'rect',
      transform: { x: 10, y: 20, rotation: 0, scaleX: 1, scaleY: 1 },
      width: 100,
      height: 50,
      cornerRadius: 0,
      style: { ...DEFAULT_SHAPE_STYLE, fill: solid('#22c55e') },
    })
    expect(store().selection).toEqual([id])
    expect(store().tool).toBe('select')

    store().undo()
    expect(store().doc.pages[0].rootIds).toEqual([])
    expect(store().selection).toEqual([])
  })

  it('reads Shift and Alt as the pointer moves', () => {
    rectTool.onDown(at(100, 100))
    rectTool.onMove(mods(140, 120, true))
    expect(store().draft).toMatchObject({ width: 40, height: 40 })
    rectTool.onUp(mods(140, 120, false, true))

    const [id] = store().doc.pages[0].rootIds
    expect(store().doc.nodes[id]).toMatchObject({
      transform: { x: 60, y: 80 },
      width: 80,
      height: 40,
    })
  })

  it('draws an ellipse around its center; Shift makes a circle', () => {
    ellipseTool.onDown(at(100, 100))
    ellipseTool.onUp(mods(160, 120, true))

    const [id] = store().doc.pages[0].rootIds
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

    const [line, snapped] = store().doc.pages[0].rootIds.map((id) => store().doc.nodes[id])
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
    store().setShapeStyle({ stroke: null, fill: solid('#ef4444') })

    lineTool.onDown(at(0, 0))
    lineTool.onUp(at(100, 0))

    const [id] = store().doc.pages[0].rootIds
    expect(store().doc.nodes[id].style).toMatchObject({ fill: null, stroke: '#000000' })
    expect(lineStyleOf(store().shapeStyle).stroke).toBe('#000000')
  })

  it('draws nothing for a click, and keeps a level drag at least 1 unit tall', () => {
    rectTool.onDown(at(100, 100))
    rectTool.onUp(at(101, 101))
    expect(store().doc.pages[0].rootIds).toEqual([])
    expect(store().past).toEqual([])
    expect(store().tool).toBe('rect')

    rectTool.onDown(at(100, 100))
    rectTool.onUp(at(200, 100))
    const [id] = store().doc.pages[0].rootIds
    expect(store().doc.nodes[id]).toMatchObject({ width: 100, height: 1 })
  })

  it('measures the click slop on screen, so a tiny drag at high zoom still draws', () => {
    store().zoomTo(32)

    rectTool.onDown(at(100, 100))
    rectTool.onUp(at(100.5, 100.5))

    expect(store().doc.pages[0].rootIds).toHaveLength(1)
  })

  it('drops the draft on cancel', () => {
    rectTool.onDown(at(0, 0))
    rectTool.onMove(at(50, 50))
    rectTool.onCancel?.()
    rectTool.onUp(at(50, 50))

    expect(store().draft).toBeNull()
    expect(store().doc.pages[0].rootIds).toEqual([])
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
    expect(store().doc.pages[0].rootIds).toEqual([])

    brushTool.onUp(at(3, 4))

    expect(store().draft).toBeNull()
    expect(store().past).toHaveLength(1)
    const [id] = store().doc.pages[0].rootIds
    expect(store().doc.nodes[id]).toMatchObject({
      type: 'stroke',
      size: 20,
      style: { fill: solid('#ef4444') },
      usesPressure: false,
    })
  })

  it('uses real pressure only for pens', () => {
    for (const pointerType of ['mouse', 'touch', 'pen']) {
      brushTool.onDown(at(0, 0, pointerType))
      brushTool.onUp(at(0, 0, pointerType))
    }

    const nodes = store().doc.pages[0].rootIds.map((id) => store().doc.nodes[id] as StrokeNode)
    expect(nodes.map((n) => n.usesPressure)).toEqual([false, false, true])
    expect(new Set(store().doc.pages[0].rootIds).size).toBe(3)
  })

  it('drops the draft on cancel', () => {
    brushTool.onDown(at(0, 0))
    brushTool.onCancel?.()
    brushTool.onUp(at(0, 0))

    expect(store().draft).toBeNull()
    expect(store().doc.pages[0].rootIds).toEqual([])
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
    expect(store().doc.pages[0].rootIds).toHaveLength(2)

    eraserTool.onUp(at(50, 40))

    expect(store().erasing).toEqual([])
    expect(store().doc.pages[0].rootIds).toEqual([bottom.id])
    expect(store().past).toHaveLength(3)

    store().undo()
    expect(store().doc.pages[0].rootIds).toEqual([top.id, bottom.id])
  })

  it('skips hidden and locked nodes', () => {
    addLine(0, { hidden: true })
    addLine(0, { locked: true })

    eraserTool.onDown(at(50, 0))
    eraserTool.onUp(at(50, 0))

    expect(store().doc.pages[0].rootIds).toHaveLength(2)
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
    expect(store().doc.pages[0].rootIds).toHaveLength(1)
  })

  it('erases shapes it touches, and unfilled ones only on their outline', () => {
    const box = { x: 0, y: 0, width: 200, height: 100 }
    const empty = createRectNode(box, DEFAULT_SHAPE_STYLE)
    const filled = createEllipseNode(
      { ...box, x: 300 },
      { ...DEFAULT_SHAPE_STYLE, fill: solid('#ef4444'), stroke: null },
    )
    const arrow = createLineNode([0, 300], [200, 300], DEFAULT_SHAPE_STYLE)
    store().addNodes([empty, filled, arrow])
    store().setBrush({ size: 10 })
    const erase = (from: [number, number], to: [number, number]) => {
      eraserTool.onDown(at(...from))
      eraserTool.onMove(at(...to))
      eraserTool.onUp(at(...to))
    }

    erase([100, 50], [120, 60]) // inside the empty rectangle
    expect(store().doc.pages[0].rootIds).toEqual([empty.id, filled.id, arrow.id])
    erase([400, 50], [410, 50]) // inside the filled ellipse
    erase([100, 250], [100, 350]) // across the line
    expect(store().doc.pages[0].rootIds).toEqual([empty.id])
    erase([100, -3], [120, -3]) // along the rectangle's top edge
    expect(store().doc.pages[0].rootIds).toEqual([])
    expect(store().past).toHaveLength(4)
  })
})

describe('handTool', () => {
  beforeEach(() => {
    store().setViewport(measured(1000, 700, 0.5))
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
    store().setViewport(measured(1000, 700, 1))
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

    // Far enough down that the box's top doesn't snap to the page's.
    drag(on(50, 50), [50, 80])

    expect(transformOf(a.id).y).toBe(30)
    expect(transformOf(b.id).y).toBe(30)
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
    expect(store().doc.pages[0].rootIds).toEqual([b.id, a.id])
    selectTool.onKey?.(key('[', { metaKey: true, code: 'BracketLeft' }))
    expect(store().doc.pages[0].rootIds).toEqual([a.id, b.id])
    selectTool.onKey?.(key('}', { ctrlKey: true, shiftKey: true, code: 'BracketRight' }))
    expect(store().doc.pages[0].rootIds).toEqual([b.id, a.id])

    selectTool.onKey?.(key('d', { ctrlKey: true }))
    expect(store().doc.pages[0].rootIds).toHaveLength(3)
    const [copyId] = store().selection
    expect(copyId).not.toBe(a.id)

    selectTool.onKey?.(key('Delete'))
    expect(store().doc.pages[0].rootIds).toEqual([b.id, a.id])
    expect(store().selection).toEqual([])
    expect(selectTool.onKey?.(key('Delete'))).toBe(false)
  })

  it('cuts and copies to the clipboard', () => {
    const a = addLine(0)
    store().select([a.id])

    selectTool.onKey?.(key('c', { ctrlKey: true }))
    expect(store().doc.pages[0].rootIds).toEqual([a.id])
    selectTool.onKey?.(key('x', { ctrlKey: true }))
    expect(store().doc.pages[0].rootIds).toEqual([])

    store().paste()
    expect(store().doc.pages[0].rootIds).toHaveLength(1)
    expect(store().clipboard.map((n) => n.id)).toEqual([a.id])
  })
})

const corner = (x: number, y: number): Anchor => ({
  x,
  y,
  inX: 0,
  inY: 0,
  outX: 0,
  outY: 0,
  kind: 'corner',
})

const keyEvent = (key: string, mods: Partial<KeyboardEvent> = {}) =>
  ({
    key,
    code: '',
    shiftKey: false,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    ...mods,
  }) as KeyboardEvent

describe('penTool', () => {
  // At zoom 1, canvas units are screen pixels.
  beforeEach(() => {
    store().setViewport(measured(1000, 700, 1))
    store().setTool('pen')
  })
  // A path still being drawn ends with its test, not in the next test's fresh store.
  afterEach(() => {
    store().setTool('brush')
    penTool.onCancel?.()
  })

  const click = (x: number, y: number, shift = false) => {
    penTool.onDown({ ...at(x, y), shift })
    penTool.onUp({ ...at(x, y), shift })
  }
  function drag(from: [number, number], to: [number, number], shift = false) {
    penTool.onDown(at(...from))
    penTool.onMove({ ...at((from[0] + to[0]) / 2, (from[1] + to[1]) / 2), shift })
    penTool.onMove({ ...at(...to), shift })
    penTool.onUp(at(...to))
  }
  const draftAnchors = () => (store().draft as PathNode | null)?.contours[0].anchors
  const added = () => store().doc.nodes[store().doc.pages[0].rootIds[0]] as PathNode

  it('adds a corner per click and ends the open path on Enter, as one undo step', () => {
    click(10, 20)
    click(110, 20)
    click(110, 120)
    expect(draftAnchors()).toEqual([corner(0, 0), corner(100, 0), corner(100, 100)])
    expect(store().doc.pages[0].rootIds).toEqual([])

    expect(penTool.onKey?.(keyEvent('Enter'))).toBe(true)

    expect(store().draft).toBeNull()
    expect(store().past).toHaveLength(1)
    expect(added()).toMatchObject({
      type: 'path',
      transform: { x: 10, y: 20, rotation: 0, scaleX: 1, scaleY: 1 },
      style: DEFAULT_SHAPE_STYLE,
      contours: [{ closed: false, anchors: [corner(0, 0), corner(100, 0), corner(100, 100)] }],
    })
    expect(store().selection).toEqual([added().id])
    expect(store().tool).toBe('select')
    store().undo()
    expect(store().doc.pages[0].rootIds).toEqual([])
  })

  it('pulls out smooth handles on a drag, opposite and equal at first', () => {
    drag([100, 100], [130, 140])
    drag([300, 100], [301, 101]) // under the drag slop: a corner

    expect(draftAnchors()).toEqual([
      { x: 0, y: 0, inX: -30, inY: -40, outX: 30, outY: 40, kind: 'smooth' },
      corner(200, 0),
    ])
  })

  it('snaps anchors and handles to 45 degrees with Shift', () => {
    click(0, 0)
    click(100, 10, true)
    drag([200, 0], [230, 25], true)

    const [, second, third] = draftAnchors()!
    expect(second.x).toBeCloseTo(Math.hypot(100, 10), 9)
    expect(second.y).toBe(0)
    expect(third.outX).toBeCloseTo(third.outY, 9)
  })

  it('closes the path on a click on the first anchor', () => {
    click(0, 0)
    click(100, 0)
    click(100, 100)
    click(3, 4) // 5 px from the first anchor

    expect(store().draft).toBeNull()
    expect(added()).toMatchObject({
      contours: [{ closed: true, anchors: [corner(0, 0), corner(100, 0), corner(100, 100)] }],
    })
  })

  it('ends an open path on a click on its last anchor, or on Esc', () => {
    click(0, 0)
    click(100, 0)
    click(102, 1)
    expect(added()).toMatchObject({
      contours: [{ closed: false, anchors: [corner(0, 0), corner(100, 0)] }],
    })

    store().setTool('pen')
    click(0, 300)
    click(100, 300)
    expect(penTool.onKey?.(keyEvent('Escape'))).toBe(true)
    expect(store().doc.pages[0].rootIds).toHaveLength(2)
    expect(store().past).toHaveLength(2)
  })

  it('pulls the handles of a lone first anchor again instead of doubling it', () => {
    click(0, 0)
    drag([1, 1], [0, 50])

    expect(draftAnchors()).toEqual([
      { x: 0, y: 0, inX: 0, inY: -50, outX: 0, outY: 50, kind: 'smooth' },
    ])
  })

  it('takes back the last anchor with Backspace or Ctrl+Z, and drops a path under 2 anchors', () => {
    click(0, 0)
    click(100, 0)
    expect(penTool.onKey?.(keyEvent('Backspace'))).toBe(true)
    expect(draftAnchors()).toEqual([corner(0, 0)])
    expect(penTool.onKey?.(keyEvent('z', { ctrlKey: true }))).toBe(true)
    expect(store().draft).toBeNull()
    expect(penTool.onKey?.(keyEvent('z', { ctrlKey: true }))).toBe(false)

    click(0, 0)
    finishPath()
    expect(store().doc.pages[0].rootIds).toEqual([])
    expect(store().past).toEqual([])
  })

  it('goes on after a pinch cancels a press, and a tool switch keeps the path', () => {
    click(0, 0)
    click(100, 0)
    penTool.onDown(at(200, 50)) // the first finger of a pinch
    penTool.onCancel?.()
    expect(draftAnchors()).toEqual([corner(0, 0), corner(100, 0)])

    // CanvasStage cancels the old tool after the switch.
    store().setTool('brush')
    penTool.onCancel?.()
    expect(added().contours[0].anchors).toEqual([corner(0, 0), corner(100, 0)])
    expect(store().selection).toEqual([added().id])
    expect(store().tool).toBe('brush')
  })

  it('tracks the hovering pointer only while a path is drawn', () => {
    penTool.onHover?.(at(5, 5))
    expect(store().penHover).toBeNull()
    click(0, 0)
    penTool.onHover?.(at(50, 60))
    expect(store().penHover).toEqual([50, 60])
    penTool.onHover?.(null)
    expect(store().penHover).toBeNull()
  })
})

describe('directTool', () => {
  // At zoom 1, canvas units are screen pixels.
  beforeEach(() => {
    store().setViewport(measured(1000, 700, 1))
    store().setTool('direct')
  })

  const on = (x: number, y: number, target: string | null = null, shift = false): ToolEvent => ({
    ...at(x, y),
    target,
    shift,
  })
  const press = (e: ToolEvent) => {
    directTool.onDown(e)
    directTool.onUp(e)
  }
  const pathOf = (id: string) => store().doc.nodes[id] as PathNode

  /** An unfilled square path from (0, 0) to (100, 100), its own undo step. */
  function addSquare(): PathNode {
    const square = createPathNode(
      [corner(0, 0), corner(100, 0), corner(100, 100), corner(0, 100)],
      true,
      DEFAULT_SHAPE_STYLE,
    )
    store().addNodes([square])
    return square
  }

  it('selects what is clicked, and clears the selection on empty canvas', () => {
    const square = addSquare()
    const line = addLine(300)

    press(on(50, 0, square.id))
    expect(store().selection).toEqual([square.id])
    wait(1000)
    press(on(50, 300, line.id, true))
    expect(store().selection).toEqual([square.id, line.id])
    wait(1000)
    press(on(500, 500))
    expect(store().selection).toEqual([])
  })

  it('adds an anchor on a double-click on the outline, as one step, and makes it active', () => {
    const square = addSquare()

    press(on(50, 2, square.id))
    press(on(50, 2, square.id))

    expect(pathOf(square.id).contours[0].anchors).toHaveLength(5)
    const added = pathOf(square.id).contours[0].anchors[1]
    expect(added.x).toBeCloseTo(50, 1)
    expect(added.y).toBe(0)
    expect(added.kind).toBe('corner')
    expect(store().activeAnchor).toEqual({ id: square.id, contour: 0, index: 1 })
    expect(store().past).toHaveLength(2)
  })

  it('adds nothing on a double-click far from the outline, or one slow to follow', () => {
    const square = addSquare()
    store().updateNodes({
      [square.id]: { style: { ...DEFAULT_SHAPE_STYLE, fill: solid('#ef4444') } },
    })

    press(on(50, 50, square.id))
    press(on(50, 50, square.id))
    wait(1000)
    press(on(50, 1, square.id))
    wait(1000)
    press(on(50, 1, square.id))

    expect(pathOf(square.id).contours[0].anchors).toHaveLength(4)
  })

  it('deletes the active anchor, then the path once it has fewer than 2', () => {
    const path = createPathNode(
      [corner(0, 0), corner(50, 0), corner(100, 0)],
      false,
      DEFAULT_SHAPE_STYLE,
    )
    store().addNodes([path])
    store().select([path.id])
    store().setActiveAnchor({ id: path.id, contour: 0, index: 1 })

    expect(directTool.onKey?.(keyEvent('Delete'))).toBe(true)
    expect(pathOf(path.id).contours[0].anchors).toEqual([corner(0, 0), corner(100, 0)])
    expect(store().activeAnchor).toBeNull()

    store().setActiveAnchor({ id: path.id, contour: 0, index: 0 })
    expect(deleteActiveAnchor()).toBe(true)
    expect(store().doc.pages[0].rootIds).toEqual([])
    expect(store().selection).toEqual([])
    expect(deleteActiveAnchor()).toBe(false)
    store().undo()
    store().undo()
    expect(pathOf(path.id).contours[0].anchors).toHaveLength(3)
  })

  it('deletes and nudges the selection without an active anchor', () => {
    const square = addSquare()
    store().select([square.id])

    directTool.onKey?.(keyEvent('ArrowRight', { shiftKey: true }))
    expect(pathOf(square.id).transform).toMatchObject({ x: 10, y: 0 })
    directTool.onKey?.(keyEvent('Backspace'))
    expect(store().doc.pages[0].rootIds).toEqual([])
  })

  it('nudges the active anchor on screen, merging quick nudges into one step', () => {
    const square = addSquare()
    store().updateNodes({ [square.id]: { transform: { ...square.transform, rotation: 90 } } })
    store().select([square.id])
    store().setActiveAnchor({ id: square.id, contour: 0, index: 1 })
    const steps = store().past.length

    directTool.onKey?.(keyEvent('ArrowRight'))
    directTool.onKey?.(keyEvent('ArrowRight'))

    // Turned a quarter, the path's own -y axis points right on screen.
    const anchor = pathOf(square.id).contours[0].anchors[1]
    expect(anchor.x).toBeCloseTo(100, 9)
    expect(anchor.y).toBeCloseTo(-2, 9)
    expect(store().past).toHaveLength(steps + 1)
  })

  it('drags anchors and handles, in the path coordinates, one undo step at a time', () => {
    const smooth: Anchor = { x: 100, y: 0, inX: -20, inY: 0, outX: 20, outY: 0, kind: 'smooth' }
    const path = createPathNode([corner(0, 0), smooth, corner(200, 0)], false, DEFAULT_SHAPE_STYLE)
    store().addNodes([{ ...path, transform: { ...path.transform, x: 1000, y: 500 } }])
    const ref = { id: path.id, contour: 0, index: 1 }

    store().beginGesture()
    moveAnchorTo(ref, [1090, 510])
    moveAnchorTo(ref, [1100, 520])
    store().endGesture()
    expect(pathOf(path.id).contours[0].anchors[1]).toMatchObject({
      x: 100,
      y: 20,
      inX: -20,
      outX: 20,
    })
    expect(store().past).toHaveLength(2)

    // A smooth anchor turns its other handle in line; Alt breaks the link.
    moveHandleTo(ref, 'out', [1100, 560], false)
    expect(pathOf(path.id).contours[0].anchors[1]).toMatchObject({
      outX: 0,
      outY: 40,
      inX: 0,
      inY: -20,
    })
    moveHandleTo(ref, 'out', [1130, 520], true)
    expect(pathOf(path.id).contours[0].anchors[1]).toMatchObject({
      outX: 30,
      outY: 0,
      inY: -20,
      kind: 'corner',
    })
    expect(store().past).toHaveLength(4)
  })

  it('sets the active anchor kind, pulling out handles for a bare corner', () => {
    const square = addSquare()
    store().select([square.id])
    store().setActiveAnchor({ id: square.id, contour: 0, index: 1 })

    setActiveAnchorKind('symmetric')

    const anchor = pathOf(square.id).contours[0].anchors[1]
    expect(anchor.kind).toBe('symmetric')
    expect(anchor.outX).toBeCloseTo(-anchor.inX, 9)
    expect(Math.hypot(anchor.outX, anchor.outY)).toBeCloseTo(100 / 3, 9)
  })

  it('clears the active anchor on Esc, then the selection', () => {
    const square = addSquare()
    store().select([square.id])
    store().setActiveAnchor({ id: square.id, contour: 0, index: 0 })

    expect(directTool.onKey?.(keyEvent('Escape'))).toBe(true)
    expect(store().activeAnchor).toBeNull()
    expect(store().selection).toEqual([square.id])
    expect(directTool.onKey?.(keyEvent('Escape'))).toBe(true)
    expect(store().selection).toEqual([])
    expect(directTool.onKey?.(keyEvent('Escape'))).toBe(false)
  })
})

describe('selectTool double-click', () => {
  beforeEach(() => {
    store().setViewport(measured(1000, 700, 1))
    store().setTool('select')
  })
  afterEach(() => {
    selectTool.onCancel?.()
    vi.useRealTimers()
  })

  const click = (x: number, y: number, target: string) => {
    const e = { ...at(x, y), target }
    selectTool.onDown(e)
    selectTool.onUp(e)
  }

  it('switches to direct select on a path, and only on a path', () => {
    const line = addLine(300)
    click(50, 300, line.id)
    click(50, 300, line.id)
    expect(store().tool).toBe('select')

    const path = createPathNode([corner(0, 0), corner(100, 0)], false, DEFAULT_SHAPE_STYLE)
    store().addNodes([path])
    wait(1000)
    click(50, 0, path.id)
    click(51, 1, path.id)
    expect(store().tool).toBe('direct')
    expect(store().selection).toEqual([path.id])
  })

  it('enters a group and picks within it until a click lands outside; Esc goes back out', () => {
    const a = addLine(0)
    const b = addLine(100)
    const c = addLine(300)
    store().group([a.id, b.id])
    const [groupId] = store().selection
    store().select([])

    click(50, 0, a.id)
    expect(store().selection).toEqual([groupId])
    click(50, 0, a.id)
    expect(store().selection).toEqual([a.id])
    wait(1000)
    click(50, 100, b.id)
    expect(store().selection).toEqual([b.id])
    wait(1000)
    click(50, 300, c.id)
    expect(store().selection).toEqual([c.id])

    store().select([a.id])
    expect(selectTool.onKey?.(keyEvent('Escape'))).toBe(true)
    expect(store().selection).toEqual([groupId])
    expect(selectTool.onKey?.(keyEvent('Escape'))).toBe(true)
    expect(store().selection).toEqual([])
  })

  it('opens a text editor on a double-click, on release', () => {
    const text = createTextNode(0, 0, 200, DEFAULT_TEXT_STYLE, 'Hi')
    store().addNodes([text])
    click(10, 10, text.id)
    const e = { ...at(10, 10), target: text.id }
    selectTool.onDown(e)
    expect(store().editingText).toBeNull()
    selectTool.onUp(e)
    expect(store().editingText).toBe(text.id)
    cancelTextEdit()
  })

  it('times presses by their events, not by when a busy main thread handles them', () => {
    vi.useFakeTimers()
    const text = createTextNode(0, 0, 200, DEFAULT_TEXT_STYLE, 'Hi')
    store().addNodes([text])

    // Presses 200 ms apart, the second handled a second after the first: a double-click.
    click(10, 10, text.id)
    vi.advanceTimersByTime(1000)
    wait(200)
    click(10, 10, text.id)
    expect(store().editingText).toBe(text.id)
    cancelTextEdit()

    // Presses 500 ms apart, handled straight away: two clicks.
    wait(1000)
    click(10, 10, text.id)
    wait(500)
    click(10, 10, text.id)
    expect(store().editingText).toBeNull()
  })
})

describe('selectTool groups from the keyboard', () => {
  it('groups with Ctrl+G and ungroups every selected group with Ctrl+Shift+G, one step each', () => {
    const a = addLine(0)
    const b = addLine(100)
    const c = addLine(200)
    const d = addLine(300)
    store().group([a.id, b.id])
    const [first] = store().selection
    store().select([c.id, d.id])

    expect(selectTool.onKey?.(keyEvent('g', { ctrlKey: true }))).toBe(true)
    const [second] = store().selection
    expect(store().doc.pages[0].rootIds).toEqual([first, second])
    const steps = store().past.length

    store().select([first, second])
    expect(selectTool.onKey?.(keyEvent('G', { ctrlKey: true, shiftKey: true }))).toBe(true)
    expect(store().doc.pages[0].rootIds).toEqual([a.id, b.id, c.id, d.id])
    expect(store().selection).toEqual([a.id, b.id, c.id, d.id])
    expect(store().past).toHaveLength(steps + 1)
  })

  it('edits a selected text, or goes into a selected group, on Enter', () => {
    const text = createTextNode(0, 0, 200, DEFAULT_TEXT_STYLE, 'Hi')
    store().addNodes([text])
    const a = addLine(0)
    store().group([a.id])
    const [groupId] = store().selection

    expect(selectTool.onKey?.(keyEvent('Enter'))).toBe(true)
    expect(store().selection).toEqual([a.id])
    store().select([text.id])
    expect(selectTool.onKey?.(keyEvent('Enter'))).toBe(true)
    expect(store().editingText).toBe(text.id)
    cancelTextEdit()
    expect(store().selection).toEqual([text.id])
    expect(groupId in store().doc.nodes).toBe(true)
  })
})

describe('selectTool align and distribute from the keyboard', () => {
  const plain = { ...DEFAULT_SHAPE_STYLE, stroke: null, fill: solid('#000000') }
  const addRects = (...xs: number[]) => {
    const rects = xs.map((x, i) => createRectNode({ x, y: 100 * i, width: 100, height: 50 }, plain))
    store().addNodes(rects)
    return rects.map((r) => r.id)
  }
  const box = (id: string) => {
    const t = store().doc.nodes[id].transform
    return { left: t.x, top: t.y }
  }

  it('aligns on Alt + A, H, D, W, V and S, one undo step each', () => {
    const ids = addRects(100, 400, 700)
    store().select(ids)
    const steps = store().past.length
    const press = (key: string) =>
      selectTool.onKey?.(keyEvent(key, { altKey: true, code: `Key${key.toUpperCase()}` }))

    expect(press('d')).toBe(true)
    expect(ids.map((id) => box(id).left)).toEqual([700, 700, 700])
    // Lined up already: the key is taken, and nothing is recorded.
    expect(press('a')).toBe(true)
    expect(ids.map((id) => box(id).left)).toEqual([700, 700, 700])
    expect(press('s')).toBe(true)
    expect(ids.map((id) => box(id).top)).toEqual([200, 200, 200])
    expect(store().past).toHaveLength(steps + 2)
  })

  it('reads the key by its position when Alt types another character, as Option does', () => {
    const ids = addRects(100, 400)
    store().select(ids)
    expect(selectTool.onKey?.(keyEvent('å', { altKey: true, code: 'KeyA' }))).toBe(true)
    expect(ids.map((id) => box(id).left)).toEqual([100, 100])
  })

  it('distributes on Alt + Shift + H and V', () => {
    const ids = addRects(0, 150, 900)
    store().select(ids)
    expect(selectTool.onKey?.(keyEvent('H', { altKey: true, shiftKey: true, code: 'KeyH' }))).toBe(
      true,
    )
    expect(box(ids[1]).left).toBe(450)
    expect(selectTool.onKey?.(keyEvent('V', { altKey: true, shiftKey: true, code: 'KeyV' }))).toBe(
      true,
    )
    // 0–50, 100–150 and 200–250 already have equal gaps.
    expect(box(ids[1]).top).toBe(100)
  })

  it('leaves other Alt keys, Ctrl + Alt and an empty selection to the browser', () => {
    const ids = addRects(100, 400)
    expect(selectTool.onKey?.(keyEvent('a', { altKey: true, code: 'KeyA' }))).toBe(false)
    store().select(ids)
    expect(selectTool.onKey?.(keyEvent('q', { altKey: true, code: 'KeyQ' }))).toBe(false)
    expect(selectTool.onKey?.(keyEvent('a', { altKey: true, ctrlKey: true, code: 'KeyA' }))).toBe(
      false,
    )
    expect(selectTool.onKey?.(keyEvent('A', { altKey: true, shiftKey: true, code: 'KeyA' }))).toBe(
      false,
    )
    expect(box(ids[1]).left).toBe(400)
  })
})

describe('textTool', () => {
  // At zoom 1, canvas units are screen pixels.
  beforeEach(() => {
    store().setViewport(measured(1000, 700, 1))
    store().setTool('text')
  })
  afterEach(() => {
    cancelTextEdit()
    textTool.onCancel?.()
  })

  const type = (text: string) => {
    const id = store().editingText!
    store().updateNodes({ [id]: { text } })
  }
  const textOf = (id: string) => store().doc.nodes[id] as TextNode

  it('places a text on a click and keeps what is typed as one undo step', () => {
    const { fontSize } = store().textStyle
    textTool.onDown(at(100, 200))
    textTool.onUp(at(100, 200))
    const id = store().editingText!
    expect(store().selection).toEqual([id])
    // A click places the text centered on its first line, ten font sizes wide.
    expect(textOf(id).transform).toMatchObject({ x: 100, y: 200 - (fontSize * 1.2) / 2 })
    expect(textOf(id).width).toBe(fontSize * 10)

    type('H')
    type('Hello')
    finishTextEdit()

    expect(store().editingText).toBeNull()
    expect(textOf(id).text).toBe('Hello')
    expect(store().past).toHaveLength(1)
    expect(store().tool).toBe('select')
    expect(store().selection).toEqual([id])
    store().undo()
    expect(store().doc.pages[0].rootIds).toEqual([])
  })

  it('sets the width with a drag, showing the box meanwhile', () => {
    textTool.onDown(at(300, 100))
    textTool.onMove(at(250, 120))
    expect(store().marquee).toMatchObject({ x: 250, width: 50 })
    textTool.onMove(at(100, 150))
    textTool.onUp(at(100, 150))

    expect(store().marquee).toBeNull()
    const id = store().editingText!
    expect(textOf(id)).toMatchObject({ width: 200, transform: { x: 100 } })
  })

  it('leaves nothing for a text left empty, and Esc puts an edit back', () => {
    textTool.onDown(at(100, 200))
    textTool.onUp(at(100, 200))
    type('   ')
    finishTextEdit()
    expect(store().doc.pages[0].rootIds).toEqual([])
    expect(store().past).toHaveLength(0)
    expect(store().tool).toBe('text')

    textTool.onDown(at(100, 200))
    textTool.onUp(at(100, 200))
    type('Gone')
    cancelTextEdit()
    expect(store().doc.pages[0].rootIds).toEqual([])
    expect(store().past).toHaveLength(0)
  })

  it('edits a text it clicks on; emptying it deletes it, one undo step each', () => {
    const text = createTextNode(0, 0, 200, DEFAULT_TEXT_STYLE, 'Hi')
    store().addNodes([text])
    const e = { ...at(10, 10), target: text.id }
    textTool.onDown(e)
    textTool.onUp(e)
    expect(store().editingText).toBe(text.id)
    expect(store().doc.pages[0].rootIds).toHaveLength(1)

    type('Hi there')
    finishTextEdit()
    expect(store().past).toHaveLength(2)

    startTextEdit(text.id)
    type('')
    finishTextEdit()
    expect(store().doc.pages[0].rootIds).toEqual([])
    expect(store().past).toHaveLength(3)
    store().undo()
    expect(textOf(text.id).text).toBe('Hi there')
  })

  it('does not edit hidden or locked text', () => {
    const text = { ...createTextNode(0, 0, 200, DEFAULT_TEXT_STYLE, 'Hi'), locked: true }
    store().addNodes([text])
    startTextEdit(text.id)
    expect(store().editingText).toBeNull()
  })
})

describe('eraserTool in groups', () => {
  it('erases the touched child where its group puts it, and a group it empties', () => {
    const a = addLine(0)
    const b = addLine(100)
    store().group([a.id, b.id])
    const [groupId] = store().selection
    // Moved down by 500, the group's strokes lie along y = 500 and 600.
    store().updateNodes({
      [groupId]: { transform: { x: 0, y: 500, rotation: 0, scaleX: 1, scaleY: 1 } },
    })

    eraserTool.onDown(at(50, -5))
    eraserTool.onUp(at(50, -5))
    expect(store().doc.nodes[a.id]).toBeDefined()

    eraserTool.onDown(at(50, 495))
    eraserTool.onMove(at(50, 505))
    eraserTool.onUp(at(50, 505))
    expect(a.id in store().doc.nodes).toBe(false)
    expect(store().doc.pages[0].rootIds).toEqual([groupId])

    eraserTool.onDown(at(50, 600))
    eraserTool.onUp(at(50, 600))
    expect(store().doc.nodes).toEqual({})
  })
})

describe('eraserTool in split mode', () => {
  beforeEach(() => {
    store().setEraserMode('split')
    store().setBrush({ size: 10 })
  })

  const xs = (id: string) => (store().doc.nodes[id] as StrokeNode).points.map(([x]) => x)

  it('cuts strokes as it moves, and the pass is one undo step', () => {
    const top = addLine(0)
    const bottom = addLine(100)
    const before = store().doc

    eraserTool.onDown(at(50, -40))
    eraserTool.onMove(at(50, 40)) // a fast swipe across the top line only
    const [, cutOff] = store().doc.pages[0].rootIds
    expect(store().doc.pages[0].rootIds).toEqual([top.id, cutOff, bottom.id])
    // Reach is eraser radius 5 + brush radius 4.
    expect(xs(top.id)[1]).toBeCloseTo(41, 1)
    expect(xs(cutOff)[0]).toBeCloseTo(59, 1)
    expect(store().erasing).toEqual([])

    eraserTool.onMove(at(80, 40))
    eraserTool.onMove(at(80, -40)) // a second cut, through the piece on the right
    eraserTool.onUp(at(80, -40))

    expect(store().doc.pages[0].rootIds).toHaveLength(4)
    expect(store().doc.nodes[bottom.id]).toBe(bottom)
    expect(store().past).toHaveLength(3)
    expect(store().past.at(-1)).toBe(before)
    store().undo()
    expect(store().doc).toBe(before)
  })

  it('deletes a stroke it covers whole, and a group that empties', () => {
    const short = addLine(0, {
      points: [
        [45, 0, 0.5],
        [55, 0, 0.5],
      ],
    })
    const other = addLine(100)
    store().group([short.id])

    eraserTool.onDown(at(50, 0))
    eraserTool.onUp(at(50, 0))

    expect(store().doc.pages[0].rootIds).toEqual([other.id])
    expect(Object.keys(store().doc.nodes)).toEqual([other.id])
  })

  it('leaves shapes, paths, text, and hidden or locked strokes alone', () => {
    const rect = createRectNode(
      { x: 0, y: -50, width: 100, height: 100 },
      {
        ...DEFAULT_SHAPE_STYLE,
        fill: solid('#ef4444'),
      },
    )
    const line = createLineNode([0, 0], [100, 0], DEFAULT_SHAPE_STYLE)
    const path = createPathNode([corner(0, 0), corner(100, 0)], false, DEFAULT_SHAPE_STYLE)
    const text = createTextNode(0, -20, 100, DEFAULT_TEXT_STYLE, 'Hi')
    store().addNodes([rect, line, path, text])
    addLine(0, { hidden: true })
    addLine(0, { locked: true })
    const before = store().doc
    const steps = store().past.length

    eraserTool.onDown(at(50, -40))
    eraserTool.onMove(at(50, 40))
    eraserTool.onUp(at(50, 40))

    expect(store().doc).toBe(before)
    expect(store().past).toHaveLength(steps)
  })

  it('cuts a stroke in a turned group where the group puts it', () => {
    const a = addLine(0)
    store().group([a.id])
    const [groupId] = store().selection
    // A quarter turn about (200, 0): the stroke runs down x = 200 from y = 0 to 100.
    store().updateNodes({
      [groupId]: { transform: { x: 200, y: 0, rotation: 90, scaleX: 1, scaleY: 1 } },
    })

    eraserTool.onDown(at(150, 50))
    eraserTool.onMove(at(250, 50))
    eraserTool.onUp(at(250, 50))

    const children = (store().doc.nodes[groupId] as GroupNode).childIds
    expect(children).toHaveLength(2)
    expect(children[0]).toBe(a.id)
    expect(xs(a.id)[1]).toBeCloseTo(41, 1)
    expect(xs(children[1])[0]).toBeCloseTo(59, 1)
    expect(store().doc.nodes[children[1]]).toMatchObject({ parentId: groupId })
  })

  it('cuts a scaled stroke as wide as the eraser on the canvas', () => {
    // Twice the size: the stroke runs from x = 0 to 200 along y = 0.
    const a = addLine(0, { transform: { x: 0, y: 0, rotation: 0, scaleX: 2, scaleY: 2 } })

    eraserTool.onDown(at(100, -40))
    eraserTool.onMove(at(100, 40))
    eraserTool.onUp(at(100, 40))

    // Reach on the canvas is 5 + 8: from x = 87 to 113, which is 43.5 to 56.5 in its own units.
    const [, other] = store().doc.pages[0].rootIds
    expect(xs(a.id)[1]).toBeCloseTo(43.5, 1)
    expect(xs(other)[0]).toBeCloseTo(56.5, 1)
    expect(store().doc.nodes[other].transform).toEqual(a.transform)
  })

  it('puts back what it cut on cancel, as a pinch does', () => {
    addLine(0)
    const before = store().doc
    const past = store().past

    eraserTool.onDown(at(50, -40))
    eraserTool.onMove(at(50, 40))
    expect(store().doc.pages[0].rootIds).toHaveLength(2)
    eraserTool.onCancel?.()
    eraserTool.onUp(at(50, 40))

    expect(store().doc).toBe(before)
    expect(store().past).toBe(past)
    expect(store().gestureStart).toBeNull()
  })

  it("leaves another tool's gesture alone when cancelled between passes", () => {
    const a = addLine(0)
    store().beginGesture()
    store().updateNodes({ [a.id]: { size: 20 } })

    eraserTool.onCancel?.()

    expect(store().gestureStart).not.toBeNull()
    expect((store().doc.nodes[a.id] as StrokeNode).size).toBe(20)
    store().endGesture()
  })

  it('keeps the mode a pass started with', () => {
    const a = addLine(0)

    eraserTool.onDown(at(50, -40))
    store().setEraserMode('object')
    eraserTool.onMove(at(50, 40))
    eraserTool.onUp(at(50, 40))

    expect(store().doc.pages[0].rootIds).toHaveLength(2)
    expect(store().doc.pages[0].rootIds[0]).toBe(a.id)
  })
})

describe.each([0.25, 1, 4])('snapping at %s× zoom', (zoom) => {
  // The page fits at `zoom`, centered in a 1000 × 700 canvas; at 4× only its middle shows.
  beforeEach(() => {
    selectTool.onCancel?.()
    rectTool.onCancel?.()
    store().setViewport(measured(1000, 700, zoom))
  })

  // Canvas units for a distance in screen pixels.
  const px = (n: number) => n / zoom
  const noOutline = { ...DEFAULT_SHAPE_STYLE, stroke: null, fill: solid('#000000') }

  /** A rect without an outline, so its box is its geometry, added as its own step. */
  function addRect(x: number, y: number, width = 100, height = 100) {
    const node = createRectNode({ x, y, width, height }, noOutline)
    store().addNodes([node])
    return node.id
  }

  const press = (x: number, y: number, target: string | null, mod = false): ToolEvent => ({
    ...at(x, y),
    target,
    mod,
  })

  /** Drags the node `id` by (dx, dy) with the select tool, from a point inside it. */
  function dragBy(id: string, dx: number, dy: number, mod = false) {
    const { x, y } = store().doc.nodes[id].transform
    selectTool.onDown(press(x + 1, y + 1, id))
    selectTool.onMove(press(x + 1 + dx, y + 1 + dy, null, mod))
    selectTool.onUp(press(x + 1 + dx, y + 1 + dy, null, mod))
  }

  const transformOf = (id: string) => store().doc.nodes[id].transform

  it('moves an object onto a page edge within 6 screen px, and not from further', () => {
    const near = addRect(200, 300)
    dragBy(near, -200 + px(5), 0)
    expect(transformOf(near)).toMatchObject({ x: 0, y: 300 })

    // Not near the first one either, whose center is a target now.
    store().deleteNodes([near])
    const far = addRect(200, 600)
    dragBy(far, -200 + px(7), 0)
    expect(transformOf(far).x).toBeCloseTo(px(7))

    // The right edge to the page's right.
    const right = addRect(1200, 300)
    dragBy(right, 300 - px(4), 0)
    expect(transformOf(right).x).toBe(1500)
  })

  it('moves an object onto the page center within 6 screen px, and not from further', () => {
    // 400 wide, so only its center comes near the page's.
    const near = addRect(100, 300, 400)
    dragBy(near, 500 + px(5), 0)
    expect(transformOf(near).x).toBe(600)

    const far = addRect(100, 600, 400)
    dragBy(far, 500 + px(7), 0)
    expect(transformOf(far).x).toBeCloseTo(600 + px(7))
  })

  it('moves an object onto another within 6 screen px, showing a guide while it drags', () => {
    // In view at every zoom: the canvas shows at least x 675–925 and y 412–588.
    const other = addRect(700, 420)
    const moving = addRect(300, 700)

    // Its top to the other's bottom, from 5 px below it.
    selectTool.onDown(press(301, 701, moving))
    selectTool.onMove(press(301, 701 - 180 + px(5), null))
    expect(transformOf(moving).y).toBe(520)
    expect(store().guides).toEqual([{ axis: 'y', at: 520, from: 300, to: 800 }])
    selectTool.onUp(press(301, 701 - 180 + px(5), null))
    expect(transformOf(moving).y).toBe(520)
    expect(store().guides).toEqual([])
    expect(transformOf(other).y).toBe(420)

    // From 7 px below, it stays where it is dropped.
    store().undo()
    dragBy(moving, 0, -180 + px(7))
    expect(transformOf(moving).y).toBeCloseTo(520 + px(7))
  })

  it('draws a shape whose dragged corner snaps to the page corner', () => {
    store().setTool('rect')
    rectTool.onDown(at(100, 100))
    rectTool.onMove(at(1600 - px(5), 1000 - px(4)))
    expect(store().draft).toMatchObject({ width: 1500, height: 900 })
    expect(store().guides).toHaveLength(2)
    rectTool.onUp(at(1600 - px(5), 1000 - px(4)))
    const [id] = currentRoots()
    expect(store().doc.nodes[id]).toMatchObject({ width: 1500, height: 900 })
    expect(store().guides).toEqual([])

    store().setTool('rect')
    rectTool.onDown(at(100, 100))
    rectTool.onUp(at(1600 - px(7), 1000 - px(7)))
    const [, far] = currentRoots()
    expect((store().doc.nodes[far] as { width: number }).width).toBeCloseTo(1500 - px(7))
  })
})

const currentRoots = () => store().doc.pages[0].rootIds

describe('snapping', () => {
  beforeEach(() => {
    selectTool.onCancel?.()
    store().setViewport(measured(1000, 700, 1))
  })

  const noOutline = { ...DEFAULT_SHAPE_STYLE, stroke: null, fill: solid('#000000') }

  function addRect(x: number, y: number) {
    const node = createRectNode({ x, y, width: 100, height: 100 }, noOutline)
    store().addNodes([node])
    return node.id
  }

  function dragBy(id: string, dx: number, dy: number, mod = false) {
    const { x, y } = store().doc.nodes[id].transform
    const e = (px: number, py: number, target: string | null): ToolEvent => ({
      ...at(px, py),
      target,
      mod,
    })
    selectTool.onDown(e(x + 1, y + 1, id))
    selectTool.onMove(e(x + 1 + dx, y + 1 + dy, null))
    selectTool.onUp(e(x + 1 + dx, y + 1 + dy, null))
  }

  it('is skipped while Ctrl or Cmd is held', () => {
    const id = addRect(200, 300)
    dragBy(id, -197, 0, true)
    expect(store().doc.nodes[id].transform.x).toBe(3)
    expect(store().guides).toEqual([])
  })

  it('is off with the View toggle', () => {
    store().setSnapping(false)
    const id = addRect(200, 300)
    dragBy(id, -197, 0)
    expect(store().doc.nodes[id].transform.x).toBe(3)
  })

  it('takes edges to the 8-unit grid when it shows', () => {
    store().setGrid(true)
    const id = addRect(200, 300)
    // Left 213 is 3 from 216, right 313 is 1 from 312; top 321 is 1 from 320.
    dragBy(id, 13, 21)
    expect(store().doc.nodes[id].transform).toMatchObject({ x: 212, y: 320 })
  })

  it('leaves a line drawn with Shift at its 45° angle', () => {
    store().setTool('line')
    lineTool.onDown(at(100, 100))
    // Without Shift, the end would snap to the page center at (800, 500).
    lineTool.onUp({ ...at(797, 497), shift: true })
    const [id] = currentRoots()
    const { points } = store().doc.nodes[id] as { points: number[] }
    expect(points[2]).toBeCloseTo(Math.hypot(697, 397) / Math.SQRT2)
    expect(points[3]).toBeCloseTo(points[2])
  })
})
