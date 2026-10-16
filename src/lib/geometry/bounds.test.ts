import { describe, expect, it } from 'vitest'
import { solid } from '../paint/paint'
import {
  DEFAULT_TEXT_STYLE,
  createEllipseNode,
  createGroupNode,
  createLineNode,
  createPathNode,
  createRectNode,
  createStrokeNode,
  createTextNode,
} from '../../store/editorStore'
import type { Style, Transform, VectorNode } from '../../types'
import {
  applyTransform,
  arrowHeadSize,
  canvasBounds,
  cubicBox,
  inkBounds,
  invertTransform,
  nodeBounds,
  pointsBox,
  type Box,
} from './bounds'
import { corner, type Cubic, type Xy } from './pathData'

const outlined: Style = { fill: null, stroke: '#000000', strokeWidth: 4, opacity: 1 }
const filledOnly: Style = { fill: solid('#ef4444'), stroke: null, strokeWidth: 4, opacity: 1 }
const box = { x: 100, y: 200, width: 300, height: 100 }

const at = (node: VectorNode, transform: Partial<Transform>): VectorNode => ({
  ...node,
  transform: { ...node.transform, ...transform },
})

/** The box with every value rounded, so float noise from turning doesn't matter. */
function roundedBounds(node: VectorNode, nodes?: Record<string, VectorNode>) {
  const b = nodeBounds(node, nodes)
  return b && Object.fromEntries(Object.entries(b).map(([k, v]) => [k, Math.round(v * 1e6) / 1e6]))
}

describe('transforms', () => {
  it('maps canvas points back to local ones', () => {
    const t: Transform = { x: 30, y: -40, rotation: 37, scaleX: 2, scaleY: 0.5 }
    const [x, y] = applyTransform(t, 12, 34)
    const [lx, ly] = invertTransform(t, x, y)

    expect(lx).toBeCloseTo(12, 9)
    expect(ly).toBeCloseTo(34, 9)
  })
})

describe('cubicBox', () => {
  /** A point on a cubic segment, by de Casteljau's formula. */
  const pointOn = ([p0, p1, p2, p3]: Cubic, t: number): Xy => {
    const u = 1 - t
    const at = (i: 0 | 1) =>
      u * u * u * p0[i] + 3 * u * u * t * p1[i] + 3 * u * t * t * p2[i] + t * t * t * p3[i]
    return [at(0), at(1)]
  }

  it('finds every turn of a curve, turned any amount', () => {
    const arch: Xy[] = [
      [0, 0],
      [0, -100],
      [100, -100],
      [100, 0],
    ]
    const s: Xy[] = [
      [0, 0],
      [80, -120],
      [-30, 60],
      [100, 10],
    ]
    for (const shape of [arch, s]) {
      for (const rotation of [0, 30, 90, 180, 237]) {
        const turn = { x: 5, y: -7, rotation, scaleX: 1, scaleY: 1 }
        const cubic = shape.map(([x, y]) => applyTransform(turn, x, y)) as Cubic
        const sampled = pointsBox(Array.from({ length: 2001 }, (_, i) => pointOn(cubic, i / 2000)))
        const box = cubicBox(cubic)
        for (const key of ['minX', 'minY', 'maxX', 'maxY'] as (keyof Box)[]) {
          expect(box[key]).toBeCloseTo(sampled[key], 2)
        }
      }
    }
  })
})

describe('nodeBounds', () => {
  it('boxes a freehand stroke by its outline', () => {
    const stroke = createStrokeNode(
      [
        [0, 0, 0.5],
        [100, 0, 0.5],
      ],
      { color: '#000000', size: 8, usesPressure: false },
    )

    expect(nodeBounds(stroke)).toEqual({ minX: -6, minY: -6, maxX: 106, maxY: 6 })
  })

  it('includes half the outline of a rectangle, and none without an outline', () => {
    expect(nodeBounds(createRectNode(box, outlined))).toEqual({
      minX: 98,
      minY: 198,
      maxX: 402,
      maxY: 302,
    })
    expect(nodeBounds(createRectNode(box, filledOnly))).toEqual({
      minX: 100,
      minY: 200,
      maxX: 400,
      maxY: 300,
    })
  })

  it('follows a rectangle turned about its corner', () => {
    const turned = at(createRectNode(box, filledOnly), { rotation: 90 })

    expect(roundedBounds(turned)).toEqual({ minX: 0, minY: 200, maxX: 100, maxY: 500 })
  })

  it('boxes an ellipse exactly, turned or not', () => {
    const ellipse = createEllipseNode(box, outlined) // center (250, 250), radii 150 × 50

    expect(nodeBounds(ellipse)).toEqual({ minX: 98, minY: 198, maxX: 402, maxY: 302 })
    expect(roundedBounds(at(ellipse, { rotation: 90 }))).toEqual({
      minX: 198,
      minY: 98,
      maxX: 302,
      maxY: 402,
    })
    // At 45° both extents are √((152² + 52²) / 2).
    const half = Math.hypot(152, 52) / Math.SQRT2
    const turned = nodeBounds(at(ellipse, { rotation: 45 }))!
    expect(turned.maxX - 250).toBeCloseTo(half, 9)
    expect(turned.maxY - 250).toBeCloseTo(half, 9)
  })

  it('boxes a line by its ends, with room for round caps and arrowheads', () => {
    const line = createLineNode([100, 100], [300, 100], outlined)
    const reach = 2 + arrowHeadSize(4) / 2

    expect(nodeBounds(line)).toEqual({ minX: 98, minY: 98, maxX: 302, maxY: 102 })
    expect(nodeBounds({ ...line, arrowEnd: true })).toEqual({
      minX: 100 - reach,
      minY: 100 - reach,
      maxX: 300 + reach,
      maxY: 100 + reach,
    })
  })

  it('boxes a path by its curves, not its handles, with half its outline', () => {
    // An arch from (100, 100) up to (150, 25) and down to (200, 100); its handles reach y = 0.
    const arch = createPathNode(
      [
        { ...corner(100, 100), outY: -100 },
        { ...corner(200, 100), inY: -100 },
      ],
      false,
      outlined,
    )

    expect(roundedBounds(arch)).toEqual({ minX: 98, minY: 23, maxX: 202, maxY: 102 })
    expect(roundedBounds({ ...arch, style: filledOnly })).toEqual({
      minX: 100,
      minY: 25,
      maxX: 200,
      maxY: 100,
    })
    // Half a turn about the first anchor.
    expect(roundedBounds(at(arch, { rotation: 180 }))).toEqual({
      minX: -2,
      minY: 98,
      maxX: 102,
      maxY: 177,
    })
    expect(nodeBounds({ ...arch, contours: [] })).toBeNull()
  })

  it('boxes a text by its width and lines, through its transform', () => {
    // Without a canvas a glyph is 0.6 em: 'Hi there' at size 10 wraps to two lines in 30 units.
    const text = createTextNode(100, 200, 30, { ...DEFAULT_TEXT_STYLE, fontSize: 10 }, 'Hi there')

    expect(roundedBounds(text)).toEqual({ minX: 100, minY: 200, maxX: 130, maxY: 224 })
    expect(roundedBounds(at(text, { rotation: 90 }))).toEqual({
      minX: 76,
      minY: 200,
      maxX: 100,
      maxY: 230,
    })
  })

  it('boxes a group by its visible children, through its transform', () => {
    const rect = { ...createRectNode({ x: 0, y: 0, width: 100, height: 50 }, filledOnly, 'r') }
    const hidden = { ...createRectNode(box, filledOnly, 'h'), hidden: true }
    const group: VectorNode = {
      ...createGroupNode(['r', 'h'], null, 'g'),
      transform: { x: 10, y: 20, rotation: 90, scaleX: 1, scaleY: 1 },
    }
    const nodes = { g: group, r: { ...rect, parentId: 'g' }, h: { ...hidden, parentId: 'g' } }
    const turned = { minX: -40, minY: 20, maxX: 10, maxY: 120 }

    expect(roundedBounds(group, nodes)).toEqual(turned)
    expect(nodeBounds(group)).toBeNull()
    // A child on the canvas is where its group puts it.
    const child = canvasBounds(nodes, 'r')!
    expect(Object.values(child).map((v) => Math.round(v * 1e6) / 1e6)).toEqual(
      Object.values(turned),
    )
    // Its own box is in the group's coordinates.
    expect(nodeBounds(nodes.r)).toEqual({ minX: 0, minY: 0, maxX: 100, maxY: 50 })
  })
})

describe('inkBounds', () => {
  const brush = { color: '#000000', size: 16, usesPressure: false }
  const line = () =>
    createStrokeNode(
      [
        [0, 0, 0.5],
        [100, 0, 0.5],
      ],
      brush,
      's',
    )

  it('boxes a stroke by its drawn outline, within the reach nodeBounds allows for', () => {
    const stroke = line()
    const ink = inkBounds({ s: stroke }, 's')!
    const reach = nodeBounds(stroke)!
    expect(ink.minX).toBeGreaterThan(reach.minX)
    expect(ink.maxX).toBeLessThan(reach.maxX)
    expect(ink.minY).toBeGreaterThan(reach.minY)
    expect(ink.maxY).toBeLessThan(reach.maxY)
    // Around the line, at most half the brush past it.
    expect(ink.minY).toBeLessThan(0)
    expect(ink.minY).toBeGreaterThanOrEqual(-8 - 1e-9)
    expect(ink.maxX).toBeGreaterThan(100)
  })

  it("places a stroke by its transform and its groups', and a group holds its children's ink", () => {
    const stroke = { ...line(), parentId: 'g', transform: { ...line().transform, x: 10 } }
    const group = {
      ...createGroupNode(['s', 'r'], null, 'g'),
      transform: { ...line().transform, y: 20 },
    }
    const rect = { ...createRectNode(box, filledOnly, 'r'), parentId: 'g' }
    const nodes = { s: stroke, g: group, r: rect }
    const alone = inkBounds({ s: line() }, 's')!
    const placed = inkBounds(nodes, 's')!
    expect(placed.minX).toBeCloseTo(alone.minX + 10)
    expect(placed.minY).toBeCloseTo(alone.minY + 20)

    // Other nodes are boxed as canvasBounds boxes them.
    expect(inkBounds(nodes, 'r')).toEqual(canvasBounds(nodes, 'r'))
    expect(inkBounds(nodes, 'g')).toEqual({
      minX: placed.minX,
      minY: placed.minY,
      maxX: 400,
      maxY: 320,
    })
    // A hidden child leaves the group's box.
    const hidden = { ...nodes, r: { ...rect, hidden: true } }
    expect(inkBounds(hidden, 'g')).toEqual(placed)
    expect(inkBounds(nodes, 'missing')).toBeNull()
  })
})
