import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { inkBounds } from '../lib/geometry/bounds'
import { solid } from '../lib/paint/paint'
import {
  IDENTITY_TRANSFORM,
  emptyDoc,
  type AssetMeta,
  type GroupNode,
  type ImageNode,
  type Point,
  type StrokeNode,
  type VectorNode,
} from '../types'
import {
  DEFAULT_SHAPE_STYLE,
  DEFAULT_TEXT_STYLE,
  HISTORY_LIMIT,
  MAX_FONT_SIZE,
  MAX_SIZE,
  MAX_ZOOM,
  MERGE_MS,
  MIN_FONT_SIZE,
  MIN_SIZE,
  MIN_ZOOM,
  PASTE_OFFSET,
  canCombine,
  canSimplify,
  createEllipseNode,
  createGroupNode,
  createImageNode,
  createLineNode,
  createPathNode,
  createRectNode,
  createStrokeNode,
  createTextNode,
  imageBoxOn,
  reorderIds,
  shapeToPath,
  useEditorStore,
  zoomOf,
} from './editorStore'

const initialState = useEditorStore.getState()
const store = () => useEditorStore.getState()
const point = (x: number, y: number, pressure = 0.5): Point => [x, y, pressure]

function stroke(x = 0, id?: string): StrokeNode {
  return createStrokeNode(
    [point(x, 0), point(x + 10, 10)],
    { color: '#000000', size: 8, usesPressure: false },
    id,
  )
}

/** Adds one stroke as its own history step and returns it. */
function draw(x = 0, id?: string): StrokeNode {
  const node = stroke(x, id)
  store().addNodes([node])
  return node
}

const ids = () => store().doc.pages[0].rootIds

/** A measured canvas area whose box fits the 1600 × 1000 first page at `fit`. */
const measured = (width: number, height: number, fit: number) => ({
  width,
  height,
  boxWidth: 1600 * fit,
  boxHeight: 1000 * fit,
})
const node = (id: string) => store().doc.nodes[id] as StrokeNode

beforeEach(() => {
  useEditorStore.setState(initialState, true)
})

describe('nodes', () => {
  it('adds nodes at the top of the z-order', () => {
    const a = draw(0)
    const b = draw(100)

    expect(ids()).toEqual([a.id, b.id])
    expect(store().doc.nodes[a.id]).toBe(a)
  })

  it('skips nodes whose id already exists', () => {
    const a = draw(0, 'same')
    store().addNodes([stroke(50, 'same')])

    expect(ids()).toEqual(['same'])
    expect(store().doc.nodes.same).toBe(a)
    expect(store().past).toHaveLength(1)
  })

  it('updates only the nodes it names, keeping the others as the same objects', () => {
    const a = draw(0)
    const b = draw(100)

    store().updateNodes({ [a.id]: { size: 20 } })

    expect(node(a.id).size).toBe(20)
    expect(store().doc.nodes[b.id]).toBe(b)
  })

  it('deletes nodes from the map and the z-order', () => {
    const a = draw(0)
    const b = draw(100)

    store().deleteNodes([a.id])

    expect(ids()).toEqual([b.id])
    expect(store().doc.nodes[a.id]).toBeUndefined()
  })

  it('records nothing for edits that change nothing', () => {
    const a = draw(0)
    const before = store().doc

    store().updateNodes({ missing: { size: 2 } })
    store().updateNodes({ [a.id]: { size: a.size } })
    store().deleteNodes(['missing'])
    store().addNodes([a])

    expect(store().doc).toBe(before)
    expect(store().past).toHaveLength(1)
  })
})

describe('history', () => {
  it('undoes and redoes edits', () => {
    const a = draw(0)
    const b = draw(100)

    store().undo()
    expect(ids()).toEqual([a.id])

    store().redo()
    expect(ids()).toEqual([a.id, b.id])
  })

  it('reuses the same doc and node objects across undo and redo', () => {
    const a = draw()
    const doc = store().doc

    store().undo()
    store().redo()

    expect(store().doc).toBe(doc)
    expect(store().doc.nodes[a.id]).toBe(a)
  })

  it('can undo a clear', () => {
    draw(0)
    draw(100)
    const before = store().doc

    store().clear()
    expect(ids()).toEqual([])

    store().undo()
    expect(store().doc).toBe(before)
  })

  it('can redo a clear', () => {
    draw()
    store().clear()
    store().undo()
    store().redo()

    expect(ids()).toEqual([])
    expect(store().doc.nodes).toEqual({})
  })

  it('does not record a step when clearing an empty canvas', () => {
    store().clear()

    expect(store().past).toEqual([])
  })

  it('empties the redo stack when a new edit is made', () => {
    draw(0)
    draw(100)
    store().undo()
    expect(store().future).toHaveLength(1)

    draw(200)

    expect(store().future).toEqual([])
    store().redo()
    expect(ids()).toHaveLength(2)
  })

  it('keeps deletions in history like any other edit', () => {
    const a = draw(0)
    const b = draw(100)
    store().deleteNodes([a.id])

    store().undo()
    expect(ids()).toEqual([a.id, b.id])

    store().redo()
    expect(ids()).toEqual([b.id])
  })

  it(`caps the undo stack at ${HISTORY_LIMIT} steps`, () => {
    for (let i = 0; i < HISTORY_LIMIT + 20; i++) draw(i)

    expect(store().past).toHaveLength(HISTORY_LIMIT)

    for (let i = 0; i < HISTORY_LIMIT + 20; i++) store().undo()

    // The oldest 20 steps were dropped, so undo stops with 20 strokes left.
    expect(store().past).toEqual([])
    expect(ids()).toHaveLength(20)
  })

  it('does nothing when there is nothing to undo or redo', () => {
    store().undo()
    store().redo()

    expect(ids()).toEqual([])
    expect(store().past).toEqual([])
    expect(store().future).toEqual([])
  })

  it('drops selected ids that the restored doc no longer has', () => {
    const a = draw(0)
    const b = draw(100)
    store().select([a.id, b.id])

    store().undo()
    expect(store().selection).toEqual([a.id])

    store().redo()
    expect(store().selection).toEqual([a.id])
  })
})

describe('gestures', () => {
  it('records a whole drag as one undo step', () => {
    const a = draw(0)
    const before = store().doc

    store().beginGesture()
    for (let size = 9; size <= 30; size++) {
      store().updateNodes({ [a.id]: { size } })
    }
    expect(store().past).toHaveLength(1)
    store().endGesture()

    expect(node(a.id).size).toBe(30)
    expect(store().past).toHaveLength(2)

    store().undo()
    expect(store().doc).toBe(before)
  })

  it('records nothing for a gesture that changed nothing', () => {
    draw(0)

    store().beginGesture()
    store().endGesture()

    expect(store().past).toHaveLength(1)
    expect(store().gestureStart).toBeNull()
  })

  it('empties the redo stack when a gesture changes the doc', () => {
    const a = draw(0)
    draw(100)
    store().undo()

    store().beginGesture()
    store().updateNodes({ [a.id]: { size: 12 } })
    store().endGesture()

    expect(store().future).toEqual([])
  })

  it('ignores undo and redo while a gesture is open', () => {
    const a = draw(0)
    store().beginGesture()
    store().updateNodes({ [a.id]: { size: 12 } })

    store().undo()
    store().redo()

    expect(node(a.id).size).toBe(12)
    store().endGesture()
    expect(store().past).toHaveLength(2)
  })

  it('ignores a second beginGesture while one is open', () => {
    const a = draw(0)
    const before = store().doc

    store().beginGesture()
    store().updateNodes({ [a.id]: { size: 12 } })
    store().beginGesture()
    store().updateNodes({ [a.id]: { size: 16 } })
    store().endGesture()

    store().undo()
    expect(store().doc).toBe(before)
  })
})

describe('selection', () => {
  it('replaces, adds and toggles, ignoring unknown ids', () => {
    const a = draw(0)
    const b = draw(100)

    store().select([a.id, 'missing'])
    expect(store().selection).toEqual([a.id])

    store().select([b.id], 'add')
    expect(store().selection).toEqual([a.id, b.id])

    store().select([a.id], 'toggle')
    expect(store().selection).toEqual([b.id])
  })

  it('drops deleted and cleared nodes from the selection', () => {
    const a = draw(0)
    const b = draw(100)
    store().select([a.id, b.id])

    store().deleteNodes([a.id])
    expect(store().selection).toEqual([b.id])

    store().clear()
    expect(store().selection).toEqual([])
  })
})

describe('settings', () => {
  it(`clamps brush size to ${MIN_SIZE}–${MAX_SIZE} whole units`, () => {
    store().setBrush({ size: 0 })
    expect(store().brush.size).toBe(MIN_SIZE)

    store().setBrush({ size: 500 })
    expect(store().brush.size).toBe(MAX_SIZE)

    store().setBrush({ size: 12.6 })
    expect(store().brush.size).toBe(13)

    store().setBrush({ size: Number.NaN })
    expect(store().brush.size).toBe(MIN_SIZE)
  })

  it('changes the color without touching the size', () => {
    store().setBrush({ size: 20 })
    store().setBrush({ color: '#ef4444' })

    expect(store().brush).toEqual({ color: '#ef4444', size: 20 })
  })

  it('keeps tool, brush, eraser mode, draft and erasing out of history', () => {
    store().setTool('eraser')
    store().setBrush({ color: '#ef4444', size: 20 })
    store().setEraserMode('split')
    store().setDraft(stroke())
    store().setErasing(['x'])

    expect(store().past).toEqual([])
  })
})

describe('view', () => {
  // The artboard fits at half size, 800 × 500, with 100 px to spare on every side.
  const viewport = measured(1000, 700, 0.5)

  /** The canvas point under a screen point of the Stage. */
  function canvasAt([sx, sy]: [number, number]): [number, number] {
    const { view } = store()
    const zoom = zoomOf(store())
    return [(sx - view.x) / zoom, (sy - view.y) / zoom]
  }

  function expectPoint(actual: [number, number], expected: [number, number]) {
    expect(actual[0]).toBeCloseTo(expected[0], 6)
    expect(actual[1]).toBeCloseTo(expected[1], 6)
  }

  it('fits the artboard once the canvas area is measured', () => {
    store().zoomTo(2)
    expect(store().view).toEqual({ scale: 1, x: 0, y: 0 })

    store().setViewport(viewport)

    expect(store().view).toEqual({ scale: 1, x: 100, y: 100 })
    expect(zoomOf(store())).toBe(0.5)
  })

  it('zooms around the anchor, from MIN_ZOOM to MAX_ZOOM', () => {
    store().setViewport(viewport)
    const anchor: [number, number] = [300, 200]
    const under = canvasAt(anchor)

    store().zoomTo(2, anchor)
    expect(zoomOf(store())).toBeCloseTo(2, 9)
    expectPoint(canvasAt(anchor), under)

    store().zoomTo(1000, anchor)
    expect(zoomOf(store())).toBeCloseTo(MAX_ZOOM, 9)
    expectPoint(canvasAt(anchor), under)

    store().zoomTo(0, anchor)
    expect(zoomOf(store())).toBeCloseTo(MIN_ZOOM, 9)
    expectPoint(canvasAt(anchor), under)
  })

  it('zooms around the middle by default', () => {
    store().setViewport(viewport)

    store().zoomTo(1)

    expect(zoomOf(store())).toBeCloseTo(1, 9)
    expectPoint(canvasAt([500, 350]), [800, 500])
  })

  it('pans, and fits the artboard again', () => {
    store().setViewport(viewport)
    store().zoomTo(3)

    store().panBy(10, -20)
    const { x, y } = store().view
    store().panBy(5, 5)
    expect(store().view).toMatchObject({ x: x + 5, y: y + 5 })

    store().fitView()
    expect(store().view).toEqual({ scale: 1, x: 100, y: 100 })
  })

  it('keeps the middle and the zoom relative to the fit when the canvas area resizes', () => {
    store().setViewport(viewport)
    store().setViewport(measured(400, 900, 0.2))
    // Still fitted: 320 × 200, centered.
    expect(store().view).toEqual({ scale: 1, x: 40, y: 350 })

    store().zoomTo(2, [100, 400])
    const middle = canvasAt([200, 450])
    store().setViewport(measured(800, 500, 0.4))

    expect(store().view.scale).toBeCloseTo(10, 9)
    expectPoint(canvasAt([400, 250]), middle)
  })

  it('ignores zoom and fit until the canvas area is measured', () => {
    store().zoomTo(4)
    store().fitView()
    store().setViewport(measured(0, 0, 0))

    expect(store().view).toEqual({ scale: 1, x: 0, y: 0 })
  })

  it('keeps zoom and pan out of history', () => {
    store().setViewport(viewport)
    const doc = store().doc

    store().zoomTo(2)
    store().panBy(10, 10)
    store().setView({ scale: 3, x: 1, y: 2 })
    store().fitView()

    expect(store().doc).toBe(doc)
    expect(store().past).toEqual([])
  })
})

describe('cancelGesture', () => {
  it('puts the doc back as it was when the gesture began, with no step recorded', () => {
    draw(0, 'a')
    const before = store().doc

    store().beginGesture()
    store().updateNodes({ a: { size: 30 } })
    store().cancelGesture()

    expect(store().doc).toBe(before)
    expect(store().gestureStart).toBeNull()
    expect(store().past).toHaveLength(1)
  })
})

describe('z-order', () => {
  it('moves picked ids one step or all the way, keeping runs and their order', () => {
    const list = ['a', 'b', 'c', 'd', 'e']
    expect(reorderIds(list, new Set(['b', 'c']), 'forward')).toEqual(['a', 'd', 'b', 'c', 'e'])
    expect(reorderIds(list, new Set(['b', 'd']), 'forward')).toEqual(['a', 'c', 'b', 'e', 'd'])
    expect(reorderIds(list, new Set(['e']), 'forward')).toEqual(list)
    expect(reorderIds(list, new Set(['c', 'd']), 'backward')).toEqual(['a', 'c', 'd', 'b', 'e'])
    expect(reorderIds(list, new Set(['b', 'd']), 'front')).toEqual(['a', 'c', 'e', 'b', 'd'])
    expect(reorderIds(list, new Set(['b', 'd']), 'back')).toEqual(['b', 'd', 'a', 'c', 'e'])
  })

  it('reorders as one step, and records nothing when already at the edge', () => {
    draw(0, 'a')
    draw(10, 'b')
    draw(20, 'c')

    store().reorder(['a'], 'front')
    expect(ids()).toEqual(['b', 'c', 'a'])
    expect(store().past).toHaveLength(4)

    store().reorder(['a'], 'forward')
    expect(store().past).toHaveLength(4)

    store().undo()
    expect(ids()).toEqual(['a', 'b', 'c'])
  })
})

describe('nudge', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it(`moves unlocked nodes, merging nudges less than ${MERGE_MS} ms apart`, () => {
    vi.useFakeTimers()
    draw(0, 'a')
    draw(10, 'b')
    store().updateNodes({ b: { locked: true } })
    const steps = store().past.length

    store().nudge(['a', 'b'], 1, 0)
    vi.advanceTimersByTime(MERGE_MS - 100)
    store().nudge(['a', 'b'], 0, 10)

    expect(node('a').transform).toMatchObject({ x: 1, y: 10 })
    expect(node('b').transform).toMatchObject({ x: 0, y: 0 })
    expect(store().past).toHaveLength(steps + 1)

    vi.advanceTimersByTime(MERGE_MS + 100)
    store().nudge(['a'], 1, 0)
    expect(store().past).toHaveLength(steps + 2)

    store().undo()
    store().undo()
    expect(node('a').transform).toMatchObject({ x: 0, y: 0 })
  })

  it('starts a new step after any other edit', () => {
    vi.useFakeTimers()
    draw(0, 'a')

    store().nudge(['a'], 1, 0)
    draw(10, 'b')
    store().nudge(['a'], 1, 0)

    expect(store().past).toHaveLength(4)
    expect(node('a').transform.x).toBe(2)
  })
})

describe('merged updates', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it(`merges updates with the same key less than ${MERGE_MS} ms apart`, () => {
    vi.useFakeTimers()
    draw(0, 'a')

    // A slider drag: many values, one step back to where it began.
    for (const size of [10, 12, 14]) {
      store().updateNodes({ a: { size } }, 'size')
      vi.advanceTimersByTime(MERGE_MS - 100)
    }
    expect(store().past).toHaveLength(2)

    vi.advanceTimersByTime(200)
    store().updateNodes({ a: { size: 20 } }, 'size')
    expect(store().past).toHaveLength(3)

    store().undo()
    expect(node('a').size).toBe(14)
    store().undo()
    expect(node('a').size).toBe(8)
  })

  it('keeps different keys, plain updates and nudges apart', () => {
    vi.useFakeTimers()
    draw(0, 'a')

    store().updateNodes({ a: { size: 10 } }, 'size')
    store().updateNodes({ a: { usesPressure: true } }, 'pressure')
    store().updateNodes({ a: { size: 12 } })
    store().updateNodes({ a: { size: 14 } })
    store().nudge(['a'], 1, 0)
    store().updateNodes({ a: { size: 16 } }, 'size')

    expect(store().past).toHaveLength(7)
  })
})

describe('setFill', () => {
  it('gives nodes their fills as one step, leaving out ones that already have them', () => {
    draw(0, 'a')
    draw(10, 'b')
    const steps = store().past.length
    const linear = {
      kind: 'linear' as const,
      stops: [
        { offset: 0, color: '#ef4444', opacity: 1 },
        { offset: 1, color: '#ffffff', opacity: 1 },
      ],
      start: [0, 0.5] as [number, number],
      end: [1, 0.5] as [number, number],
    }
    store().setFill({ a: linear, b: solid('#000000') })
    expect(node('a').style.fill).toEqual(linear)
    // b's fill was already black: a fresh paint of the same color is no change.
    expect(node('b').style.fill).toEqual(solid('#000000'))
    expect(store().past).toHaveLength(steps + 1)
    store().setFill({ a: structuredClone(linear), b: solid('#000000') })
    expect(store().past).toHaveLength(steps + 1)
    store().undo()
    expect(node('a').style.fill).toEqual(solid('#000000'))
  })
})

describe('shape style and new shapes', () => {
  it('keeps the style for new shapes outside history, with clamped width and opacity', () => {
    store().setShapeStyle({ fill: solid('#ef4444'), strokeWidth: 500, opacity: 2 })
    expect(store().shapeStyle).toEqual({
      fill: solid('#ef4444'),
      stroke: '#000000',
      strokeWidth: MAX_SIZE,
      opacity: 1,
    })

    store().setShapeStyle({ stroke: null, strokeWidth: -3, opacity: -1 })
    expect(store().shapeStyle).toMatchObject({ stroke: null, strokeWidth: MIN_SIZE, opacity: 0 })
    expect(store().past).toEqual([])
  })

  it('places a rect at its corner, an ellipse at its center and a line at its start', () => {
    const box = { x: 10, y: 20, width: 100, height: 50 }

    expect(createRectNode(box, DEFAULT_SHAPE_STYLE, 'r')).toMatchObject({
      id: 'r',
      type: 'rect',
      name: 'Rectangle',
      transform: { ...IDENTITY_TRANSFORM, x: 10, y: 20 },
      style: DEFAULT_SHAPE_STYLE,
      width: 100,
      height: 50,
      cornerRadius: 0,
    })
    expect(createEllipseNode(box, DEFAULT_SHAPE_STYLE)).toMatchObject({
      type: 'ellipse',
      transform: { x: 60, y: 45 },
      rx: 50,
      ry: 25,
    })
    expect(createLineNode([10, 20], [110, 70], DEFAULT_SHAPE_STYLE)).toMatchObject({
      type: 'line',
      transform: { x: 10, y: 20 },
      points: [0, 0, 100, 50],
      arrowStart: false,
      arrowEnd: false,
    })
  })
})

describe('duplicate, copy and paste', () => {
  it('duplicates on top, offset and under new ids, selected, as one step', () => {
    const a = draw(0, 'a')
    draw(10, 'b')

    store().duplicate(['a'])

    expect(ids()).toHaveLength(3)
    const copyId = ids()[2]
    expect(copyId).not.toBe('a')
    expect(node(copyId)).toMatchObject({
      points: a.points,
      transform: { x: PASTE_OFFSET, y: PASTE_OFFSET },
    })
    expect(store().selection).toEqual([copyId])
    expect(store().past).toHaveLength(3)
  })

  it('keeps the z-order of what it duplicates', () => {
    const a = draw(0, 'a')
    draw(10, 'b')
    const c = draw(20, 'c')

    store().duplicate(['c', 'a'])

    expect(node(ids()[3]).points).toBe(a.points)
    expect(node(ids()[4]).points).toBe(c.points)
  })

  it('pastes each copy further from the original, even after it is deleted', () => {
    draw(0, 'a')
    store().copy(['a'])
    expect(store().past).toHaveLength(1)

    store().paste()
    store().paste()
    store().deleteNodes(['a'])
    store().paste()

    expect(ids().map((id) => node(id).transform.x)).toEqual([
      PASTE_OFFSET,
      2 * PASTE_OFFSET,
      3 * PASTE_OFFSET,
    ])
    expect(store().selection).toEqual([ids()[2]])
  })

  it('copies a group with its children under new ids', () => {
    const group = {
      id: 'g',
      type: 'group',
      name: 'Group',
      parentId: null,
      transform: IDENTITY_TRANSFORM,
      style: { fill: null, stroke: null, strokeWidth: 0, opacity: 1 },
      hidden: false,
      locked: false,
      childIds: [],
    } satisfies VectorNode
    store().addNodes([group])
    store().addNodes([stroke(0, 'child')], 'g')

    store().duplicate(['g'])

    expect(ids()).toHaveLength(2)
    const copy = store().doc.nodes[ids()[1]]
    if (copy.type !== 'group') throw new Error('expected a group')
    expect(copy.childIds).toHaveLength(1)
    const [childId] = copy.childIds
    expect(childId).not.toBe('child')
    expect(store().doc.nodes[childId]).toMatchObject({ parentId: copy.id, transform: { x: 0 } })
    expect(copy.transform).toMatchObject({ x: PASTE_OFFSET, y: PASTE_OFFSET })
  })
})

describe('paths', () => {
  const corner = (x: number, y: number) => ({
    x,
    y,
    inX: 0,
    inY: 0,
    outX: 0,
    outY: 0,
    kind: 'corner' as const,
  })
  const box = { x: 10, y: 20, width: 100, height: 50 }

  it('places a new path at its first anchor', () => {
    expect(
      createPathNode([corner(10, 20), corner(110, 70)], false, DEFAULT_SHAPE_STYLE, 'p'),
    ).toMatchObject({
      id: 'p',
      type: 'path',
      name: 'Path',
      transform: { ...IDENTITY_TRANSFORM, x: 10, y: 20 },
      contours: [{ anchors: [corner(0, 0), corner(100, 50)], closed: false }],
      fillRule: 'nonzero',
    })
  })

  it('converts shapes to paths in place, as one undo step', () => {
    const rect = { ...createRectNode(box, DEFAULT_SHAPE_STYLE), name: 'Door' }
    const ellipse = createEllipseNode(box, { ...DEFAULT_SHAPE_STYLE, fill: solid('#ef4444') })
    const line = { ...createLineNode([0, 0], [50, 0], DEFAULT_SHAPE_STYLE), arrowEnd: true }
    const locked = { ...createRectNode(box, DEFAULT_SHAPE_STYLE), locked: true }
    const freehand = stroke()
    store().addNodes([rect, ellipse, line, locked, freehand])
    store().select([rect.id, ellipse.id])
    const before = store().doc

    store().convertToPath([rect.id, ellipse.id, line.id, locked.id, freehand.id])

    expect(store().past.at(-1)).toBe(before)
    expect(ids()).toEqual(before.pages[0].rootIds)
    expect(store().selection).toEqual([rect.id, ellipse.id])
    expect(store().doc.nodes[rect.id]).toEqual(shapeToPath(rect))
    expect(store().doc.nodes[rect.id]).toMatchObject({ name: 'Door', contours: [{ closed: true }] })
    expect(store().doc.nodes[ellipse.id]).toMatchObject({
      type: 'path',
      name: 'Path',
      transform: ellipse.transform,
      style: ellipse.style,
    })
    expect(store().doc.nodes[line.id]).toMatchObject({
      type: 'path',
      contours: [{ closed: false }],
    })
    expect(store().doc.nodes[line.id]).not.toHaveProperty('arrowEnd')
    expect(store().doc.nodes[locked.id]).toBe(locked)
    expect(store().doc.nodes[freehand.id]).toBe(freehand)

    store().undo()
    expect(store().doc).toBe(before)
    store().convertToPath([freehand.id, locked.id])
    expect(store().past).toHaveLength(1)
  })

  it('keeps the active anchor only while its path stays selected', () => {
    const path = createPathNode([corner(0, 0), corner(10, 0)], false, DEFAULT_SHAPE_STYLE)
    const other = draw()
    store().addNodes([path])
    store().select([path.id])
    store().setActiveAnchor({ id: path.id, contour: 0, index: 1 })

    store().select([other.id], 'add')
    expect(store().activeAnchor).toEqual({ id: path.id, contour: 0, index: 1 })
    store().select([other.id])
    expect(store().activeAnchor).toBeNull()
  })
})

describe('groups', () => {
  /** A 10 × 10 rectangle at (x, 0), its own undo step. */
  function box(x: number, id: string): VectorNode {
    const node = createRectNode({ x, y: 0, width: 10, height: 10 }, DEFAULT_SHAPE_STYLE, id)
    store().addNodes([node])
    return node
  }
  const nodeOf = (id: string) => store().doc.nodes[id]
  const groupOf = (id: string) => store().doc.nodes[id] as GroupNode

  it('groups nodes in place of the front-most one, as one step, and selects the group', () => {
    box(0, 'a')
    box(20, 'b')
    box(40, 'c')
    const before = store().doc

    store().group(['c', 'a'])

    const [groupId] = store().selection
    expect(ids()).toEqual(['b', groupId])
    expect(groupOf(groupId)).toMatchObject({
      type: 'group',
      name: 'Group',
      parentId: null,
      transform: IDENTITY_TRANSFORM,
      childIds: ['a', 'c'],
    })
    expect(nodeOf('a')).toMatchObject({ parentId: groupId, transform: { x: 0, y: 0 } })
    expect(store().past.at(-1)).toBe(before)

    store().undo()
    expect(store().doc).toBe(before)
    expect(store().selection).toEqual([])
  })

  it('ungroups in place, passing the group transform and opacity to the children', () => {
    box(0, 'a')
    box(20, 'b')
    box(40, 'c')
    store().group(['a', 'b'])
    const [groupId] = store().selection
    store().updateNodes({
      [groupId]: {
        transform: { x: 100, y: 0, rotation: 90, scaleX: 1, scaleY: 1 },
        style: { fill: null, stroke: null, strokeWidth: 0, opacity: 0.5 },
      },
    })
    const before = store().doc

    store().ungroup(groupId)

    expect(ids()).toEqual(['a', 'b', 'c'])
    expect(groupId in store().doc.nodes).toBe(false)
    expect(store().selection).toEqual(['a', 'b'])
    // (20, 0) in the group is (100, 20) on the canvas.
    expect(nodeOf('b').parentId).toBeNull()
    expect(nodeOf('b').transform.x).toBeCloseTo(100)
    expect(nodeOf('b').transform).toMatchObject({ y: 20, rotation: 90 })
    expect(nodeOf('b').style.opacity).toBe(0.5)
    expect(store().past.at(-1)).toBe(before)
  })

  it('moves nodes into a group, out of it and along the z-order, keeping them on the canvas', () => {
    box(0, 'a')
    box(20, 'b')
    box(40, 'c')
    store().group(['b'])
    const [groupId] = store().selection
    store().updateNodes({ [groupId]: { transform: { ...IDENTITY_TRANSFORM, x: 5, y: 7 } } })
    const steps = store().past.length

    store().moveNodes(['a'], groupId, 0)
    expect(groupOf(groupId).childIds).toEqual(['a', 'b'])
    expect(nodeOf('a')).toMatchObject({ parentId: groupId, transform: { x: -5, y: -7 } })
    expect(store().past).toHaveLength(steps + 1)

    // Out to the top of the doc: the group keeps 'b'.
    store().moveNodes(['a'], null, 2)
    expect(ids()).toEqual([groupId, 'c', 'a'])
    expect(nodeOf('a')).toMatchObject({ parentId: null, transform: { x: 0, y: 0 } })

    // Where it already is: no step.
    store().moveNodes(['a'], null, 2)
    expect(store().past).toHaveLength(steps + 2)

    // A group can't go inside itself, and a group left empty goes.
    store().moveNodes([groupId], groupId, 0)
    expect(store().past).toHaveLength(steps + 2)
    store().moveNodes(['b'], null, 0)
    expect(groupId in store().doc.nodes).toBe(false)
    expect(ids()).toEqual(['b', 'c', 'a'])
  })

  it('deletes a group once its last child is deleted', () => {
    box(0, 'a')
    box(20, 'b')
    store().group(['a', 'b'])
    const [groupId] = store().selection

    store().deleteNodes(['a'])
    expect(groupOf(groupId).childIds).toEqual(['b'])
    store().deleteNodes(['b'])
    expect(store().doc.nodes).toEqual({})
    expect(ids()).toEqual([])
  })

  it('groups nodes from different groups, keeping them on the canvas', () => {
    box(0, 'a')
    box(20, 'b')
    store().group(['a'])
    const [inner] = store().selection
    store().updateNodes({ [inner]: { transform: { ...IDENTITY_TRANSFORM, x: 100 } } })

    store().group(['a', 'b'])

    const [outer] = store().selection
    expect(ids()).toEqual([outer])
    expect(groupOf(outer).childIds).toEqual(['a', 'b'])
    expect(nodeOf('a').transform.x).toBe(100)
    // The emptied inner group went.
    expect(inner in store().doc.nodes).toBe(false)
  })

  it('duplicates a child inside its group, and pastes a copied child at the top level', () => {
    box(0, 'a')
    box(20, 'b')
    store().group(['a', 'b'])
    const [groupId] = store().selection
    store().updateNodes({ [groupId]: { transform: { ...IDENTITY_TRANSFORM, x: 100 } } })

    store().duplicate(['a'])
    const [copy] = store().selection
    expect(groupOf(groupId).childIds).toEqual(['a', 'b', copy])
    expect(nodeOf(copy).transform).toMatchObject({ x: PASTE_OFFSET, y: PASTE_OFFSET })

    store().copy(['b'])
    store().paste()
    const [pasted] = store().selection
    expect(ids()).toEqual([groupId, pasted])
    expect(nodeOf(pasted).transform).toMatchObject({ x: 120 + PASTE_OFFSET, y: PASTE_OFFSET })
  })

  it('nudges a child of a turned group along the canvas', () => {
    box(0, 'a')
    store().group(['a'])
    const [groupId] = store().selection
    store().updateNodes({ [groupId]: { transform: { ...IDENTITY_TRANSFORM, rotation: 90 } } })

    store().nudge(['a', groupId], 5, 0)

    // The group carries its child, so only the group moves.
    expect(nodeOf(groupId).transform).toMatchObject({ x: 5, y: 0 })
    expect(nodeOf('a').transform).toMatchObject({ x: 0, y: 0 })
    store().nudge(['a'], 5, 0)
    expect(nodeOf('a').transform.x).toBeCloseTo(0)
    expect(nodeOf('a').transform.y).toBeCloseTo(-5)
  })
})

describe('hidden and locked nodes', () => {
  it('can not be selected, nor can anything in a hidden or locked group', () => {
    draw(0, 'a')
    draw(10, 'b')
    draw(20, 'c')
    store().group(['c'])
    const [groupId] = store().selection
    store().updateNodes({ a: { hidden: true }, b: { locked: true }, [groupId]: { locked: true } })

    store().select(['a', 'b', 'c', groupId])
    expect(store().selection).toEqual([])
  })

  it('leave the selection when hidden or locked, and stay out after undo', () => {
    draw(0, 'a')
    draw(10, 'b')
    store().select(['a', 'b'])

    store().updateNodes({ a: { hidden: true } })
    expect(store().selection).toEqual(['b'])
    store().updateNodes({ b: { locked: true } })
    expect(store().selection).toEqual([])

    store().undo()
    store().select(['a', 'b'])
    expect(store().selection).toEqual(['b'])
  })
})

describe('text', () => {
  it('creates text in the text style, with no outline', () => {
    const style = { ...DEFAULT_TEXT_STYLE, fill: '#ef4444', fontStyle: 'italic' as const }

    expect(createTextNode(10, 20, 300, style, 'Hi', 't')).toEqual({
      id: 't',
      type: 'text',
      name: 'Text',
      parentId: null,
      transform: { ...IDENTITY_TRANSFORM, x: 10, y: 20 },
      style: { fill: solid('#ef4444'), stroke: null, strokeWidth: 0, opacity: 1 },
      hidden: false,
      locked: false,
      text: 'Hi',
      fontFamily: DEFAULT_TEXT_STYLE.fontFamily,
      fontSize: DEFAULT_TEXT_STYLE.fontSize,
      fontStyle: 'italic',
      align: 'left',
      width: 300,
    })
  })

  it(`keeps the style for new text outside history, its size ${MIN_FONT_SIZE}–${MAX_FONT_SIZE}`, () => {
    store().setTextStyle({ fontSize: 1000, align: 'center' })
    expect(store().textStyle).toMatchObject({ fontSize: MAX_FONT_SIZE, align: 'center' })
    store().setTextStyle({ fontSize: 2 })
    expect(store().textStyle.fontSize).toBe(MIN_FONT_SIZE)
    expect(store().past).toHaveLength(0)
  })
})

describe('files', () => {
  it('adds a group with its children in one step, the group on top and the children inside', () => {
    const before = draw(0)
    const group = createGroupNode(['x', 'y'], null, 'g')
    const x = { ...stroke(10, 'x'), parentId: 'g' }
    const y = { ...stroke(20, 'y'), parentId: 'g' }

    store().addNodes([group, x, y])

    expect(ids()).toEqual([before.id, 'g'])
    expect(store().doc.nodes.g).toEqual(group)
    expect(store().doc.nodes.x.parentId).toBe('g')
    expect(store().past).toHaveLength(2)
  })

  it('opens a doc in place of the drawing as one undo step, dropping the selection', () => {
    const a = draw(0)
    store().select([a.id])
    const blank = emptyDoc()
    const opened = {
      ...blank,
      pages: [{ ...blank.pages[0], rootIds: ['b'] }],
      nodes: { b: stroke(5, 'b') },
    }

    store().replaceDoc(opened)

    expect(store().doc).toBe(opened)
    expect(store().selection).toEqual([])
    store().undo()
    expect(ids()).toEqual([a.id])
    store().redo()
    expect(store().doc).toBe(opened)
  })

  it('ends an open gesture before opening, as its own step', () => {
    const a = draw(0)
    store().beginGesture()
    store().updateNodes({ [a.id]: { size: 20 } })
    store().replaceDoc(emptyDoc())

    expect(store().gestureStart).toBeNull()
    expect(store().past).toHaveLength(3)
    store().undo()
    expect(node(a.id).size).toBe(20)
  })

  it('shows one toast at a time, which only its own timer dismisses', () => {
    store().showToast('first')
    const first = store().toast!
    store().showToast('second')
    store().dismissToast(first.id)

    expect(store().toast?.message).toBe('second')
    store().dismissToast(store().toast!.id)
    expect(store().toast).toBeNull()
  })
})

describe('splitStrokes', () => {
  const run = (...xs: number[]) => xs.map((x) => point(x, 0))

  it('keeps the first run in the stroke and puts the others just above it, as one step', () => {
    const a = draw(0)
    const b = draw(100)
    const before = store().doc
    store().select([a.id])

    store().splitStrokes({ [a.id]: [run(0, 2), run(6, 8), run(9, 10)] })

    const [, second, third] = ids()
    expect(ids()).toEqual([a.id, second, third, b.id])
    expect(node(a.id).points).toEqual(run(0, 2))
    expect(node(second)).toEqual({ ...a, id: second, points: run(6, 8) })
    expect(node(third).points).toEqual(run(9, 10))
    expect(store().doc.nodes[b.id]).toBe(b)
    expect(store().selection).toEqual([a.id])
    expect(store().past.at(-1)).toBe(before)

    store().undo()
    expect(store().doc).toBe(before)
  })

  it('deletes a stroke with no runs left, and a group it empties', () => {
    const a = draw(0)
    const b = draw(100)
    store().group([a.id])
    const [groupId] = store().selection

    store().splitStrokes({ [a.id]: [] })

    expect(ids()).toEqual([b.id])
    expect(groupId in store().doc.nodes).toBe(false)
    expect(store().selection).toEqual([])
  })

  it('splits a stroke inside its group', () => {
    const a = draw(0)
    const b = draw(100)
    store().group([a.id, b.id])
    const [groupId] = store().selection

    store().splitStrokes({ [a.id]: [run(0, 2), run(6, 8)] })

    const children = (store().doc.nodes[groupId] as GroupNode).childIds
    expect(children).toEqual([a.id, children[1], b.id])
    expect(node(children[1])).toMatchObject({ parentId: groupId, points: run(6, 8) })
    expect(ids()).toEqual([groupId])
  })

  it('leaves other nodes, missing ids and unchanged strokes alone', () => {
    const a = draw(0)
    const rect = createRectNode({ x: 0, y: 0, width: 10, height: 10 }, DEFAULT_SHAPE_STYLE)
    store().addNodes([rect])
    const before = store().doc

    store().splitStrokes({ [rect.id]: [], missing: [], [a.id]: [a.points] })

    expect(store().doc).toBe(before)
    expect(store().past).toHaveLength(2)
  })

  it('records one step for a gesture of many cuts', () => {
    const a = draw(0)
    const before = store().doc

    store().beginGesture()
    store().splitStrokes({ [a.id]: [run(0, 2), run(6, 10)] })
    const [, second] = ids()
    store().splitStrokes({ [second]: [] })
    store().endGesture()

    expect(ids()).toEqual([a.id])
    expect(store().past).toHaveLength(2)
    expect(store().past.at(-1)).toBe(before)
  })
})

describe('pages', () => {
  const pages = () => store().doc.pages
  const current = () => store().currentPageId
  const rootsOn = (index: number) => pages()[index].rootIds

  it('adds a page after the current one, the same size, and shows it, as one undo step', () => {
    store().resizePage('page-1', 794, 1123)
    const before = store().doc

    store().addPage()

    expect(pages()).toHaveLength(2)
    expect(pages()[1]).toMatchObject({ name: 'Page 2', width: 794, height: 1123, rootIds: [] })
    expect(current()).toBe(pages()[1].id)
    expect(store().past.at(-1)).toBe(before)
    store().undo()
    expect(store().doc).toBe(before)
    expect(current()).toBe('page-1')
  })

  it('draws, selects and clears on the current page only', () => {
    const a = draw(0)
    store().addPage()
    const b = draw(10)

    expect(rootsOn(0)).toEqual([a.id])
    expect(rootsOn(1)).toEqual([b.id])
    store().select([a.id, b.id])
    expect(store().selection).toEqual([b.id])
    store().clear()
    expect(rootsOn(0)).toEqual([a.id])
    expect(rootsOn(1)).toEqual([])
    expect(store().doc.nodes[a.id]).toBe(a)
  })

  it('duplicates a page with copies of its objects under new ids, and shows the copy', () => {
    const a = draw(0)
    store().addNodes([createGroupNode(['x'], null, 'g'), { ...stroke(5, 'x'), parentId: 'g' }])
    const before = store().doc

    store().duplicatePage('page-1')

    expect(pages().map((page) => page.name)).toEqual(['Page 1', 'Page 1 copy'])
    const [copyA, copyG] = rootsOn(1)
    expect(current()).toBe(pages()[1].id)
    expect(copyA).not.toBe(a.id)
    expect(store().doc.nodes[copyA]).toEqual({ ...a, id: copyA })
    const group = store().doc.nodes[copyG] as GroupNode
    expect(group.childIds).toHaveLength(1)
    expect(store().doc.nodes[group.childIds[0]].parentId).toBe(copyG)
    expect(store().past.at(-1)).toBe(before)
  })

  it('deletes a page and what is on it, shows its neighbour, and never deletes the last page', () => {
    store().addPage()
    const second = current()
    const b = draw(10)
    const before = store().doc

    store().deletePage(second)

    expect(pages().map((page) => page.id)).toEqual(['page-1'])
    expect(store().doc.nodes[b.id]).toBeUndefined()
    expect(current()).toBe('page-1')
    store().deletePage('page-1')
    expect(pages()).toHaveLength(1)

    // Undo brings the page back, and shows it.
    store().undo()
    expect(store().doc).toBe(before)
    expect(current()).toBe(second)
  })

  it('reorders pages as one step, and records nothing when a page stays put', () => {
    store().addPage()
    store().addPage()
    const [first, second, third] = pages().map((page) => page.id)
    const steps = store().past.length

    store().movePage(first, 2)
    expect(pages().map((page) => page.id)).toEqual([second, third, first])
    store().movePage(first, 2)
    expect(store().past).toHaveLength(steps + 1)
    // Reordering touches no page's content, so the current page stays.
    expect(current()).toBe(third)
  })

  it('resizes a page anchored top-left, or scales its content to fit, centered', () => {
    const rect = {
      ...createRectNode({ x: 100, y: 100, width: 200, height: 100 }, DEFAULT_SHAPE_STYLE, 'r'),
      cornerRadius: 10,
    }
    store().addNodes([rect])

    store().resizePage('page-1', 800, 1000)
    expect(pages()[0]).toMatchObject({ width: 800, height: 1000 })
    expect(store().doc.nodes.r).toBe(rect)

    store().resizePage('page-1', 1600, 1000)
    // From 1600 × 1000 to 800 × 1000: half the size, centered vertically.
    store().resizePage('page-1', 800, 1000, true)
    expect(store().doc.nodes.r).toMatchObject({
      transform: { x: 50, y: 300, rotation: 0, scaleX: 1, scaleY: 1 },
      width: 100,
      height: 50,
      cornerRadius: 5,
      style: { ...DEFAULT_SHAPE_STYLE, strokeWidth: 2 },
    })
    expect(store().past).toHaveLength(4)

    store().resizePage('page-1', 1, 99999)
    expect(pages()[0]).toMatchObject({ width: 16, height: 8000 })
  })

  it('names and recolors a page, merging quick color picks into one step', () => {
    store().updatePage('page-1', { name: '  Cover ' })
    store().updatePage('page-1', { name: '   ' })
    expect(pages()[0].name).toBe('Cover')

    store().updatePage('page-1', { background: solid('#ff0000') }, 'background')
    store().updatePage('page-1', { background: solid('#00ff00') }, 'background')
    expect(pages()[0].background).toEqual(solid('#00ff00'))
    expect(store().past).toHaveLength(2)
    // The same color again records nothing.
    store().updatePage('page-1', { background: solid('#00ff00') })
    expect(store().past).toHaveLength(2)
  })

  it('moves or copies objects to another page where they are on the canvas, one step each', () => {
    const group = {
      ...createGroupNode(['c'], null, 'g'),
      transform: { ...IDENTITY_TRANSFORM, x: 100 },
    }
    const child = { ...stroke(0, 'c'), parentId: 'g', transform: { ...IDENTITY_TRANSFORM, x: 10 } }
    store().addNodes([group, child, stroke(50, 'other')])
    store().addPage()
    const second = current()
    store().setCurrentPage('page-1')

    store().moveToPage(['other'], second, true)
    const copied = rootsOn(1)[0]
    expect(copied).not.toBe('other')
    expect(store().doc.nodes[copied]).toEqual({ ...store().doc.nodes.other, id: copied })
    expect(store().toast?.message).toBe('Copied 1 object to Page 2.')

    store().moveToPage(['c'], second, false)
    expect(rootsOn(0)).toEqual(['other'])
    expect(rootsOn(1)).toEqual([copied, 'c'])
    expect(store().doc.nodes.c).toMatchObject({ parentId: null, transform: { x: 110 } })
    // The group it emptied went with it.
    expect(store().doc.nodes.g).toBeUndefined()
    expect(store().toast?.message).toBe('Moved 1 object to Page 2.')
    expect(current()).toBe('page-1')

    store().undo()
    expect(store().doc.nodes.c.parentId).toBe('g')
    expect(current()).toBe('page-1')
  })

  it('shows the page an undone or redone change was made on', () => {
    draw(0)
    store().addPage()
    const second = current()
    draw(10)
    store().setCurrentPage('page-1')

    store().undo()
    expect(current()).toBe(second)
    expect(rootsOn(1)).toEqual([])
    // Undoing the added page goes back to the page it was added from.
    store().undo()
    expect(current()).toBe('page-1')
    store().redo()
    expect(current()).toBe(second)
  })

  it('remembers the zoom and pan of each page, and fits a page whose size changed', () => {
    store().setViewport({ width: 1000, height: 700, boxWidth: 800, boxHeight: 500 })
    store().zoomTo(2, [300, 200])
    const zoomed = store().view

    store().addPage()
    expect(store().view).toEqual({ scale: 1, x: 100, y: 100 })
    // A square page in an 800 × 500 box fits at 0.5.
    store().resizePage(current(), 1000, 1000)
    expect(store().viewport.fit).toBe(0.5)
    expect(store().view).toEqual({ scale: 1, x: 250, y: 100 })

    store().setCurrentPage('page-1')
    expect(store().viewport.fit).toBe(0.5)
    expect(store().view.scale).toBeCloseTo(zoomed.scale, 9)
    expect(store().view.x).toBeCloseTo(zoomed.x, 9)
    expect(store().view.y).toBeCloseTo(zoomed.y, 9)
    // Views stay out of history.
    expect(store().past).toHaveLength(2)
  })

  it('ends an open gesture before showing another page, and drops the selection', () => {
    const a = draw(0)
    store().addPage()
    const second = current()
    store().setCurrentPage('page-1')
    store().select([a.id])
    store().beginGesture()
    store().updateNodes({ [a.id]: { size: 20 } })

    store().setCurrentPage(second)

    expect(store().gestureStart).toBeNull()
    expect(store().selection).toEqual([])
    store().undo()
    expect(node(a.id).size).toBe(8)
  })
})

describe('align and distribute', () => {
  const plain = { ...DEFAULT_SHAPE_STYLE, stroke: null, fill: solid('#000000') }
  const rect = (x: number, y: number, rotation = 0) => {
    const node = createRectNode({ x, y, width: 100, height: 50 }, plain)
    return { ...node, transform: { ...node.transform, rotation } }
  }
  const boxes = (list: string[]) => list.map((id) => inkBounds(store().doc.nodes, id)!)

  it('aligns as one undo step, rotated objects by their axis-aligned boxes', () => {
    const a = rect(100, 100)
    const b = rect(400, 300, 45)
    const c = rect(700, 600)
    store().addNodes([a, b, c])
    store().select([a.id, b.id, c.id])
    const steps = store().past.length

    store().align(store().selection, 'right')

    for (const box of boxes([a.id, b.id, c.id])) expect(box.maxX).toBeCloseTo(800, 9)
    expect(store().past).toHaveLength(steps + 1)
    expect(store().selection).toEqual([a.id, b.id, c.id])
    store().undo()
    expect(store().doc.nodes[b.id]).toEqual(b)
  })

  it('aligns one object to its page, and records nothing when nothing moves', () => {
    const a = rect(100, 100)
    store().addNodes([a])
    store().align([a.id], 'bottom')
    expect(boxes([a.id])[0].maxY).toBe(1000)
    const steps = store().past.length
    store().align([a.id], 'bottom')
    store().align([], 'left')
    expect(store().past).toHaveLength(steps)
  })

  it('aligns a group as a whole, not what it holds', () => {
    const a = rect(100, 100)
    const b = rect(300, 200)
    const c = rect(600, 400)
    store().addNodes([a, b, c])
    store().group([a.id, b.id])
    const [g] = store().selection
    store().align([g, a.id, c.id], 'left')
    expect(boxes([g, c.id]).map((box) => box.minX)).toEqual([100, 100])
    // Its children kept their places in it.
    expect(boxes([a.id, b.id]).map((box) => box.minX)).toEqual([100, 300])
  })

  it('distributes as one undo step, and needs 3 objects', () => {
    const a = rect(0, 100)
    const b = rect(150, 100)
    const c = rect(900, 100)
    store().addNodes([a, b, c])
    const steps = store().past.length

    store().distribute([a.id, b.id], 'x')
    expect(store().past).toHaveLength(steps)
    store().distribute([a.id, b.id, c.id], 'x')

    const [boxA, boxB, boxC] = boxes([a.id, b.id, c.id])
    expect(boxB.minX - boxA.maxX).toBeCloseTo(boxC.minX - boxB.maxX, 9)
    expect(store().past).toHaveLength(steps + 1)
    store().undo()
    expect(store().doc.nodes[b.id]).toEqual(b)
  })
})

describe('boolean operations', () => {
  const filled = { ...DEFAULT_SHAPE_STYLE, stroke: null, fill: solid('#ef4444') }
  const rect = (x: number, y: number, w = 100, h = 100) =>
    createRectNode({ x, y, width: w, height: h }, filled)
  const circle = (cx: number, cy: number, r: number) =>
    createEllipseNode({ x: cx - r, y: cy - r, width: 2 * r, height: 2 * r }, filled)

  it('combines only 2 or more unlocked shapes, paths and freehand strokes', () => {
    const a = rect(0, 0)
    const b = circle(50, 50, 20)
    const t = createTextNode(0, 0, 100, DEFAULT_TEXT_STYLE, 'Hi')
    const s = stroke(0)
    store().addNodes([a, b, t, s, { ...rect(0, 0), id: 'locked', locked: true }])
    const doc = () => store().doc
    expect(canCombine(doc(), [a.id, b.id])).toBe(true)
    expect(canCombine(doc(), [a.id, s.id])).toBe(true)
    expect(canCombine(doc(), [a.id])).toBe(false)
    expect(canCombine(doc(), [a.id, a.id])).toBe(false)
    expect(canCombine(doc(), [a.id, t.id])).toBe(false)
    expect(canCombine(doc(), [a.id, 'locked'])).toBe(false)
    store().group([a.id, b.id])
    expect(canCombine(doc(), [store().selection[0], s.id])).toBe(false)
    expect(canSimplify(doc(), [s.id])).toBe(false)
  })

  it("replaces the inputs with one path at the bottom one's place, as one undo step", async () => {
    const below = rect(500, 500)
    const a = rect(0, 0, 200, 100)
    const middle = rect(600, 600)
    const b = circle(100, 50, 30)
    store().addNodes([below, a, middle, b])
    store().select([b.id, a.id])
    const steps = store().past.length

    expect(await store().booleanOp(store().selection, 'subtract')).toBe(true)

    const result = store().doc.nodes[a.id]
    expect(result.type).toBe('path')
    expect(result.type === 'path' && result.contours).toHaveLength(2)
    expect(store().doc.nodes[b.id]).toBeUndefined()
    expect(ids()).toEqual([below.id, a.id, middle.id])
    expect(store().selection).toEqual([a.id])
    expect(store().past).toHaveLength(steps + 1)

    store().undo()
    expect(store().doc.nodes[a.id]).toEqual(a)
    expect(store().doc.nodes[b.id]).toEqual(b)
    expect(ids()).toEqual([below.id, a.id, middle.id, b.id])
  })

  it("puts the result in the bottom input's group and drops groups it empties", async () => {
    const a = rect(0, 0)
    const b = rect(50, 50)
    const c = rect(300, 0)
    store().addNodes([a, b, c])
    store().group([a.id, b.id])
    const [outer] = store().selection
    store().group([c.id])
    const [inner] = store().selection
    // The layers panel can pick nodes from different groups.
    expect(await store().booleanOp([c.id, a.id], 'union')).toBe(true)
    const nodes = store().doc.nodes
    expect(nodes[a.id].parentId).toBe(outer)
    expect(nodes[inner]).toBeUndefined()
    expect((nodes[outer] as GroupNode).childIds).toEqual([a.id, b.id])
    expect(ids()).toEqual([outer])
  })

  it("changes nothing and says why when nothing is left or the shapes don't qualify", async () => {
    const a = rect(0, 0)
    const b = rect(500, 500)
    store().addNodes([a, b])
    const doc = store().doc
    expect(await store().booleanOp([a.id, b.id], 'intersect')).toBe(false)
    expect(store().doc).toBe(doc)
    expect(store().toast?.message).toMatch(/overlap/)
    expect(await store().booleanOp([a.id], 'union')).toBe(false)
    expect(store().doc).toBe(doc)
  })

  it('simplifies paths as one undo step', async () => {
    const points: Point[] = []
    for (let x = 0; x <= 600; x += 10) points.push(point(x, 100 + 20 * Math.sin(x / 40)))
    const s = createStrokeNode(points, { color: '#000000', size: 20, usesPressure: false })
    const r = rect(-20, 50)
    store().addNodes([s, r])
    await store().booleanOp([s.id, r.id], 'union')
    const before = store().doc.nodes[s.id]
    if (before.type !== 'path') throw new Error('not a path')
    const steps = store().past.length

    expect(await store().simplify([s.id])).toBe(true)
    const after = store().doc.nodes[s.id]
    if (after.type !== 'path') throw new Error('not a path')
    const count = (p: typeof after) => p.contours.reduce((n, c) => n + c.anchors.length, 0)
    expect(count(after)).toBeLessThan(count(before) / 2)
    expect(store().past).toHaveLength(steps + 1)
    expect(store().toast?.message).toMatch(/^Simplified from \d+ anchors to \d+\.$/)
    // Once simple, it stays as it is.
    expect(await store().simplify([s.id])).toBe(false)
    expect(store().past).toHaveLength(steps + 1)
  })
})

const photo: AssetMeta = {
  id: 'a'.repeat(64),
  mime: 'image/jpeg',
  width: 4000,
  height: 3000,
  bytes: 2_000_000,
}
const icon: AssetMeta = { id: 'b'.repeat(64), mime: 'image/png', width: 64, height: 32, bytes: 900 }
const image = (id: string) => store().doc.nodes[id] as ImageNode

describe('images', () => {
  it('fits a new image inside 80% of the page, centered, and keeps a small one at its size', () => {
    // 4000 × 3000 on a 1600 × 1000 page: 80% of the height is the limit.
    const box = imageBoxOn({ width: 1600, height: 1000 }, photo)
    expect(box.width).toBeCloseTo((800 * 4) / 3)
    expect(box.height).toBe(800)
    expect(box.x).toBeCloseTo((1600 - (800 * 4) / 3) / 2)
    expect(box.y).toBe(100)
    expect(imageBoxOn({ width: 1600, height: 1000 }, icon)).toEqual({
      x: 768,
      y: 484,
      width: 64,
      height: 32,
    })
  })

  it('imports images and their asset records as one undo step, selected', () => {
    const imported = store().importImages([
      { asset: photo, name: 'Holiday' },
      { asset: icon, name: 'Logo' },
    ])

    expect(ids()).toEqual(imported)
    expect(store().selection).toEqual(imported)
    expect(store().doc.assets).toEqual({ [photo.id]: photo, [icon.id]: icon })
    const [first, second] = imported.map(image)
    expect(first).toMatchObject({ type: 'image', name: 'Holiday', assetId: photo.id, crop: null })
    // Each one a little below and right of the one before.
    expect(second.transform.x).toBe(768 + PASTE_OFFSET)
    expect(second.transform.y).toBe(484 + PASTE_OFFSET)
    expect(store().past).toHaveLength(1)

    store().undo()
    expect(ids()).toEqual([])
    expect(store().doc.assets).toEqual({})
  })

  it('stores an image imported twice once', () => {
    store().importImages([{ asset: icon, name: 'Logo' }])
    store().importImages([{ asset: { ...icon }, name: 'Logo again' }])

    expect(ids()).toHaveLength(2)
    expect(Object.keys(store().doc.assets)).toEqual([icon.id])
  })

  it('keeps the asset record of a deleted image, for undo', () => {
    const [id] = store().importImages([{ asset: icon, name: 'Logo' }])
    store().deleteNodes([id])

    expect(store().doc.nodes[id]).toBeUndefined()
    expect(store().doc.assets[icon.id]).toEqual(icon)
  })

  it('pastes images with their asset records, even into a drawing opened since', () => {
    const [id] = store().importImages([{ asset: icon, name: 'Logo' }])
    store().copy([id])
    expect(store().clipboardAssets).toEqual({ [icon.id]: icon })
    store().replaceDoc(emptyDoc())

    store().paste()

    const [pasted] = ids()
    expect(image(pasted).assetId).toBe(icon.id)
    expect(store().doc.assets).toEqual({ [icon.id]: icon })
  })

  it('duplicates images on the same asset', () => {
    const [id] = store().importImages([{ asset: icon, name: 'Logo' }])
    store().duplicate([id])

    expect(ids()).toHaveLength(2)
    expect(image(ids()[1]).assetId).toBe(icon.id)
  })

  it('resets a crop to the whole image, keeping the shown part in place, as one step', () => {
    const node = {
      ...createImageNode(icon, { x: 100, y: 50, width: 64, height: 64 }, 'Logo', 'logo'),
      // The right half, at 2 units per pixel.
      crop: { x: 32, y: 0, width: 32, height: 32 },
    }
    useEditorStore.setState({ doc: { ...store().doc, assets: { [icon.id]: icon } } })
    store().addNodes([node])
    const steps = store().past.length

    store().resetCrop(['logo', 'missing'])

    expect(image('logo')).toMatchObject({ width: 128, height: 64, crop: null })
    expect(image('logo').transform).toMatchObject({ x: 36, y: 50 })
    expect(store().past).toHaveLength(steps + 1)
    // Nothing to reset: no step.
    store().resetCrop(['logo'])
    expect(store().past).toHaveLength(steps + 1)
  })

  it('stays out of boolean operations', () => {
    const [a] = store().importImages([{ asset: icon, name: 'Logo' }])
    const rect = createRectNode({ x: 0, y: 0, width: 10, height: 10 }, DEFAULT_SHAPE_STYLE)
    store().addNodes([rect])

    expect(canCombine(store().doc, [a, rect.id])).toBe(false)
  })
})
