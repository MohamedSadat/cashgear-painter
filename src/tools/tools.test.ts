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
import type { Anchor, PathNode, Point, StrokeNode, TextNode } from '../types'
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
    store().setViewport({ width: 1000, height: 700, fit: 1 })
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
  const draftAnchors = () => (store().draft as PathNode | null)?.anchors
  const added = () => store().doc.nodes[store().doc.rootIds[0]] as PathNode

  it('adds a corner per click and ends the open path on Enter, as one undo step', () => {
    click(10, 20)
    click(110, 20)
    click(110, 120)
    expect(draftAnchors()).toEqual([corner(0, 0), corner(100, 0), corner(100, 100)])
    expect(store().doc.rootIds).toEqual([])

    expect(penTool.onKey?.(keyEvent('Enter'))).toBe(true)

    expect(store().draft).toBeNull()
    expect(store().past).toHaveLength(1)
    expect(added()).toMatchObject({
      type: 'path',
      closed: false,
      transform: { x: 10, y: 20, rotation: 0, scaleX: 1, scaleY: 1 },
      style: DEFAULT_SHAPE_STYLE,
      anchors: [corner(0, 0), corner(100, 0), corner(100, 100)],
    })
    expect(store().selection).toEqual([added().id])
    expect(store().tool).toBe('select')
    store().undo()
    expect(store().doc.rootIds).toEqual([])
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
      closed: true,
      anchors: [corner(0, 0), corner(100, 0), corner(100, 100)],
    })
  })

  it('ends an open path on a click on its last anchor, or on Esc', () => {
    click(0, 0)
    click(100, 0)
    click(102, 1)
    expect(added()).toMatchObject({ closed: false, anchors: [corner(0, 0), corner(100, 0)] })

    store().setTool('pen')
    click(0, 300)
    click(100, 300)
    expect(penTool.onKey?.(keyEvent('Escape'))).toBe(true)
    expect(store().doc.rootIds).toHaveLength(2)
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
    expect(store().doc.rootIds).toEqual([])
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
    expect(added().anchors).toEqual([corner(0, 0), corner(100, 0)])
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
  // At zoom 1, canvas units are screen pixels. Presses are a second apart unless a test wants a
  // double-click.
  beforeEach(() => {
    vi.useFakeTimers()
    vi.advanceTimersByTime(1000)
    store().setViewport({ width: 1000, height: 700, fit: 1 })
    store().setTool('direct')
  })
  afterEach(() => {
    vi.useRealTimers()
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
    vi.advanceTimersByTime(1000)
    press(on(50, 300, line.id, true))
    expect(store().selection).toEqual([square.id, line.id])
    vi.advanceTimersByTime(1000)
    press(on(500, 500))
    expect(store().selection).toEqual([])
  })

  it('adds an anchor on a double-click on the outline, as one step, and makes it active', () => {
    const square = addSquare()

    press(on(50, 2, square.id))
    press(on(50, 2, square.id))

    expect(pathOf(square.id).anchors).toHaveLength(5)
    const added = pathOf(square.id).anchors[1]
    expect(added.x).toBeCloseTo(50, 1)
    expect(added.y).toBe(0)
    expect(added.kind).toBe('corner')
    expect(store().activeAnchor).toEqual({ id: square.id, index: 1 })
    expect(store().past).toHaveLength(2)
  })

  it('adds nothing on a double-click far from the outline, or one slow to follow', () => {
    const square = addSquare()
    store().updateNodes({ [square.id]: { style: { ...DEFAULT_SHAPE_STYLE, fill: '#ef4444' } } })

    press(on(50, 50, square.id))
    press(on(50, 50, square.id))
    vi.advanceTimersByTime(1000)
    press(on(50, 1, square.id))
    vi.advanceTimersByTime(1000)
    press(on(50, 1, square.id))

    expect(pathOf(square.id).anchors).toHaveLength(4)
  })

  it('deletes the active anchor, then the path once it has fewer than 2', () => {
    const path = createPathNode(
      [corner(0, 0), corner(50, 0), corner(100, 0)],
      false,
      DEFAULT_SHAPE_STYLE,
    )
    store().addNodes([path])
    store().select([path.id])
    store().setActiveAnchor({ id: path.id, index: 1 })

    expect(directTool.onKey?.(keyEvent('Delete'))).toBe(true)
    expect(pathOf(path.id).anchors).toEqual([corner(0, 0), corner(100, 0)])
    expect(store().activeAnchor).toBeNull()

    store().setActiveAnchor({ id: path.id, index: 0 })
    expect(deleteActiveAnchor()).toBe(true)
    expect(store().doc.rootIds).toEqual([])
    expect(store().selection).toEqual([])
    expect(deleteActiveAnchor()).toBe(false)
    store().undo()
    store().undo()
    expect(pathOf(path.id).anchors).toHaveLength(3)
  })

  it('deletes and nudges the selection without an active anchor', () => {
    const square = addSquare()
    store().select([square.id])

    directTool.onKey?.(keyEvent('ArrowRight', { shiftKey: true }))
    expect(pathOf(square.id).transform).toMatchObject({ x: 10, y: 0 })
    directTool.onKey?.(keyEvent('Backspace'))
    expect(store().doc.rootIds).toEqual([])
  })

  it('nudges the active anchor on screen, merging quick nudges into one step', () => {
    const square = addSquare()
    store().updateNodes({ [square.id]: { transform: { ...square.transform, rotation: 90 } } })
    store().select([square.id])
    store().setActiveAnchor({ id: square.id, index: 1 })
    const steps = store().past.length

    directTool.onKey?.(keyEvent('ArrowRight'))
    directTool.onKey?.(keyEvent('ArrowRight'))

    // Turned a quarter, the path's own -y axis points right on screen.
    const anchor = pathOf(square.id).anchors[1]
    expect(anchor.x).toBeCloseTo(100, 9)
    expect(anchor.y).toBeCloseTo(-2, 9)
    expect(store().past).toHaveLength(steps + 1)
  })

  it('drags anchors and handles, in the path coordinates, one undo step at a time', () => {
    const smooth: Anchor = { x: 100, y: 0, inX: -20, inY: 0, outX: 20, outY: 0, kind: 'smooth' }
    const path = createPathNode([corner(0, 0), smooth, corner(200, 0)], false, DEFAULT_SHAPE_STYLE)
    store().addNodes([{ ...path, transform: { ...path.transform, x: 1000, y: 500 } }])
    const ref = { id: path.id, index: 1 }

    store().beginGesture()
    moveAnchorTo(ref, [1090, 510])
    moveAnchorTo(ref, [1100, 520])
    store().endGesture()
    expect(pathOf(path.id).anchors[1]).toMatchObject({ x: 100, y: 20, inX: -20, outX: 20 })
    expect(store().past).toHaveLength(2)

    // A smooth anchor turns its other handle in line; Alt breaks the link.
    moveHandleTo(ref, 'out', [1100, 560], false)
    expect(pathOf(path.id).anchors[1]).toMatchObject({ outX: 0, outY: 40, inX: 0, inY: -20 })
    moveHandleTo(ref, 'out', [1130, 520], true)
    expect(pathOf(path.id).anchors[1]).toMatchObject({
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
    store().setActiveAnchor({ id: square.id, index: 1 })

    setActiveAnchorKind('symmetric')

    const anchor = pathOf(square.id).anchors[1]
    expect(anchor.kind).toBe('symmetric')
    expect(anchor.outX).toBeCloseTo(-anchor.inX, 9)
    expect(Math.hypot(anchor.outX, anchor.outY)).toBeCloseTo(100 / 3, 9)
  })

  it('clears the active anchor on Esc, then the selection', () => {
    const square = addSquare()
    store().select([square.id])
    store().setActiveAnchor({ id: square.id, index: 0 })

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
    vi.useFakeTimers()
    vi.advanceTimersByTime(1000)
    store().setViewport({ width: 1000, height: 700, fit: 1 })
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
    vi.advanceTimersByTime(1000)
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
    vi.advanceTimersByTime(1000)

    click(50, 0, a.id)
    expect(store().selection).toEqual([groupId])
    click(50, 0, a.id)
    expect(store().selection).toEqual([a.id])
    vi.advanceTimersByTime(1000)
    click(50, 100, b.id)
    expect(store().selection).toEqual([b.id])
    vi.advanceTimersByTime(1000)
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
    expect(store().doc.rootIds).toEqual([first, second])
    const steps = store().past.length

    store().select([first, second])
    expect(selectTool.onKey?.(keyEvent('G', { ctrlKey: true, shiftKey: true }))).toBe(true)
    expect(store().doc.rootIds).toEqual([a.id, b.id, c.id, d.id])
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

describe('textTool', () => {
  // At zoom 1, canvas units are screen pixels.
  beforeEach(() => {
    store().setViewport({ width: 1000, height: 700, fit: 1 })
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
    expect(store().doc.rootIds).toEqual([])
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
    expect(store().doc.rootIds).toEqual([])
    expect(store().past).toHaveLength(0)
    expect(store().tool).toBe('text')

    textTool.onDown(at(100, 200))
    textTool.onUp(at(100, 200))
    type('Gone')
    cancelTextEdit()
    expect(store().doc.rootIds).toEqual([])
    expect(store().past).toHaveLength(0)
  })

  it('edits a text it clicks on; emptying it deletes it, one undo step each', () => {
    const text = createTextNode(0, 0, 200, DEFAULT_TEXT_STYLE, 'Hi')
    store().addNodes([text])
    const e = { ...at(10, 10), target: text.id }
    textTool.onDown(e)
    textTool.onUp(e)
    expect(store().editingText).toBe(text.id)
    expect(store().doc.rootIds).toHaveLength(1)

    type('Hi there')
    finishTextEdit()
    expect(store().past).toHaveLength(2)

    startTextEdit(text.id)
    type('')
    finishTextEdit()
    expect(store().doc.rootIds).toEqual([])
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
    expect(store().doc.rootIds).toEqual([groupId])

    eraserTool.onDown(at(50, 600))
    eraserTool.onUp(at(50, 600))
    expect(store().doc.nodes).toEqual({})
  })
})
