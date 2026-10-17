import { describe, expect, it } from 'vitest'
import {
  createEllipseNode,
  createGroupNode,
  createLineNode,
  createPathFromContours,
  createRectNode,
  createStrokeNode,
} from '../../store/editorStore'
import { applyTransform, fillBox, inkBounds } from '../geometry/bounds'
import { nodeHitsSegment } from '../geometry/hitTest'
import { corner, pathSegments } from '../geometry/pathData'
import { absoluteTransform } from '../geometry/transform'
import { placeGradient, solid } from '../paint/paint'
import type { NodeId, Paint, PathNode, Point, Style, Transform, VectorNode } from '../../types'
import { combine, simplifyPath, toPaperItem } from './booleanOp'

const FILLED: Style = { fill: solid('#ef4444'), stroke: null, strokeWidth: 4, opacity: 1 }
const OUTLINED: Style = { fill: null, stroke: '#000000', strokeWidth: 4, opacity: 1 }

type Xy = [number, number]

const mapOf = (...nodes: VectorNode[]) => Object.fromEntries(nodes.map((n) => [n.id, n]))

/** Whether the node's fill covers the canvas point, through its groups, whatever its style. */
function covers(nodes: Record<NodeId, VectorNode>, id: NodeId, [x, y]: Xy): boolean {
  const node = { ...nodes[id], style: FILLED, transform: absoluteTransform(nodes, id) }
  return nodeHitsSegment(node, [x, y], [x, y], 0)
}

const rect = (x: number, y: number, w: number, h: number, style = FILLED, id?: string) =>
  createRectNode({ x, y, width: w, height: h }, style, id)
const circle = (cx: number, cy: number, r: number, style = FILLED, id?: string) =>
  createEllipseNode({ x: cx - r, y: cy - r, width: 2 * r, height: 2 * r }, style, id)

/** A horizontal size-20 freehand stroke from (x1, y) to (x2, y), one point every 10 units. */
function stroke(x1: number, x2: number, y: number, id?: string) {
  const points: Point[] = []
  for (let x = x1; x <= x2; x += 10) points.push([x, y, 0.5])
  return createStrokeNode(points, { color: '#2563eb', size: 20, usesPressure: false }, id)
}

const anchorCount = (path: PathNode) => path.contours.reduce((n, c) => n + c.anchors.length, 0)

describe('combine', () => {
  it('subtracts a circle from a rectangle as a node-editable path with a hole', () => {
    const r = rect(100, 100, 200, 100, FILLED, 'r')
    const c = circle(200, 150, 30, OUTLINED, 'c')
    const nodes = mapOf(r, c)
    const result = combine(nodes, ['r', 'c'], 'subtract')!

    expect(result.type).toBe('path')
    // It takes the rectangle's place and style.
    expect(result.id).toBe('r')
    expect(result.name).toBe('Path')
    expect(result.style).toEqual(FILLED)
    expect(result.transform).toEqual(r.transform)
    // The outside and the hole, each a contour of 4 anchors: corners, and a circle's symmetric ones.
    expect(result.contours).toHaveLength(2)
    const [outside, hole] = [...result.contours].sort((a, b) => b.anchors.length - a.anchors.length)
    expect(outside.closed && hole.closed).toBe(true)
    const kinds = result.contours.map((c) => c.anchors.map((a) => a.kind).sort())
    expect(kinds).toContainEqual(['corner', 'corner', 'corner', 'corner'])
    expect(kinds).toContainEqual(['symmetric', 'symmetric', 'symmetric', 'symmetric'])

    const out = mapOf(result)
    expect(covers(out, 'r', [120, 120])).toBe(true)
    expect(covers(out, 'r', [200, 150])).toBe(false) // the hole
    expect(covers(out, 'r', [200, 190])).toBe(true)
    expect(covers(out, 'r', [350, 150])).toBe(false)
  })

  it('unites a rectangle with a freehand stroke', () => {
    const r = rect(100, 100, 100, 100, FILLED, 'r')
    const s = stroke(150, 400, 150, 's')
    const nodes = mapOf(r, s)
    const result = combine(nodes, ['r', 's'], 'union')!

    expect(result.contours).toHaveLength(1)
    const out = mapOf(result)
    expect(covers(out, 'r', [110, 110])).toBe(true)
    expect(covers(out, 'r', [300, 150])).toBe(true) // the stroke past the rectangle
    expect(covers(out, 'r', [300, 175])).toBe(false)
    const box = inkBounds(out, 'r')!
    const strokeBox = inkBounds(nodes, 's')!
    expect(box.maxX).toBeCloseTo(strokeBox.maxX, 0)
    expect(box.minX).toBeCloseTo(100, 3)
  })

  it('takes a freehand stroke from the bottom, keeping its color as the fill', () => {
    const s = stroke(0, 300, 100, 's')
    const r = rect(100, 0, 50, 200, OUTLINED, 'r')
    const result = combine(mapOf(s, r), ['s', 'r'], 'subtract')!

    // Two pieces left either side of the rectangle.
    expect(result.contours).toHaveLength(2)
    expect(result.style.fill).toEqual(solid('#2563eb'))
    expect(result.style.stroke).toBeNull()
    expect(result.style.strokeWidth).toBe(4)
    const out = mapOf(result)
    expect(covers(out, 's', [50, 100])).toBe(true)
    expect(covers(out, 's', [125, 100])).toBe(false)
    expect(covers(out, 's', [250, 100])).toBe(true)
  })

  it('intersects and excludes', () => {
    const a = rect(0, 0, 100, 100, FILLED, 'a')
    const b = rect(50, 50, 100, 100, FILLED, 'b')
    const nodes = mapOf(a, b)

    const both = mapOf(combine(nodes, ['a', 'b'], 'intersect')!)
    expect(covers(both, 'a', [75, 75])).toBe(true)
    expect(covers(both, 'a', [25, 25])).toBe(false)
    expect(covers(both, 'a', [125, 125])).toBe(false)

    const odd = mapOf(combine(nodes, ['a', 'b'], 'exclude')!)
    expect(covers(odd, 'a', [75, 75])).toBe(false)
    expect(covers(odd, 'a', [25, 25])).toBe(true)
    expect(covers(odd, 'a', [125, 125])).toBe(true)
  })

  it('excludes a shape inside another as a hole', () => {
    const nodes = mapOf(rect(0, 0, 100, 100, FILLED, 'a'), circle(50, 50, 20, FILLED, 'b'))
    const result = mapOf(combine(nodes, ['a', 'b'], 'exclude')!)
    expect(result.a.type === 'path' && result.a.contours).toHaveLength(2)
    expect(covers(result, 'a', [50, 50])).toBe(false)
    expect(covers(result, 'a', [10, 10])).toBe(true)
  })

  it('folds every shape in z-order: subtract takes all the upper ones from the bottom one', () => {
    const nodes = mapOf(
      rect(0, 0, 300, 100, FILLED, 'a'),
      circle(50, 50, 20, FILLED, 'b'),
      circle(250, 50, 20, FILLED, 'c'),
    )
    const result = combine(nodes, ['a', 'b', 'c'], 'subtract')!
    expect(result.contours).toHaveLength(3)
    const out = mapOf(result)
    expect(covers(out, 'a', [50, 50])).toBe(false)
    expect(covers(out, 'a', [250, 50])).toBe(false)
    expect(covers(out, 'a', [150, 50])).toBe(true)
  })

  it('gives nothing when nothing is left', () => {
    const nodes = mapOf(rect(0, 0, 50, 50, FILLED, 'a'), rect(100, 100, 50, 50, FILLED, 'b'))
    expect(combine(nodes, ['a', 'b'], 'intersect')).toBeNull()
    const covered = mapOf(rect(10, 10, 20, 20, FILLED, 'a'), rect(0, 0, 50, 50, FILLED, 'b'))
    expect(combine(covered, ['a', 'b'], 'subtract')).toBeNull()
    expect(combine(covered, ['a'], 'union')).toBeNull()
  })

  it('works in page coordinates, through transforms and groups', () => {
    // A rectangle turned 90° about its corner at (200, 100): it covers x 100..200, y 100..300.
    const turned: Transform = { x: 200, y: 100, rotation: 90, scaleX: 1, scaleY: 1 }
    const r = { ...rect(0, 0, 200, 100, FILLED, 'r'), transform: turned }
    // A circle in a group moved by (150, 200): it sits at (150, 200) on the page.
    const inner = { ...circle(0, 0, 40, FILLED, 'c'), parentId: 'g' }
    const g = {
      ...createGroupNode(['c'], null, 'g'),
      transform: { ...turned, rotation: 0, x: 150, y: 200 },
    }
    const nodes = mapOf(r, g, inner)
    const result = combine(nodes, ['r', 'c'], 'subtract')!

    // The result keeps the rectangle's turn; its anchors are in its own coordinates.
    expect(result.transform).toEqual(turned)
    const out = mapOf(result)
    expect(covers(out, 'r', [150, 200])).toBe(false)
    expect(covers(out, 'r', [150, 120])).toBe(true)
    expect(covers(out, 'r', [150, 280])).toBe(true)
    expect(covers(out, 'r', [250, 200])).toBe(false)
  })

  it('reads a path with its fill rule, and keeps open paths and lines closed or empty', () => {
    // A donut drawn with even-odd: two squares, both turning the same way.
    const square = (x: number, y: number, s: number) => ({
      anchors: [corner(x, y), corner(x + s, y), corner(x + s, y + s), corner(x, y + s)],
      closed: true,
    })
    const donut = createPathFromContours(
      [square(0, 0, 100), square(25, 25, 50)],
      FILLED,
      'evenodd',
      'd',
    )
    const plug = rect(40, 40, 20, 20, FILLED, 'p')
    const line = createLineNode([0, 200], [100, 200], OUTLINED, 'l')
    const result = combine(mapOf(donut, plug, line), ['d', 'p', 'l'], 'union')!
    const out = mapOf(result)
    expect(covers(out, 'd', [10, 10])).toBe(true)
    expect(covers(out, 'd', [30, 30])).toBe(false) // still a hole
    expect(covers(out, 'd', [50, 50])).toBe(true) // plugged
    // The line has no area, so it adds nothing.
    expect(inkBounds(out, 'd')!.maxY).toBeCloseTo(100, 3)
  })

  it('cleans a freehand outline that crosses itself', () => {
    // A tight zigzag: perfect-freehand's outline folds over itself at each turn.
    const points: Point[] = [
      [0, 0, 0.5],
      [100, 10, 0.5],
      [0, 20, 0.5],
      [100, 30, 0.5],
      [0, 40, 0.5],
    ]
    const s = createStrokeNode(points, { color: '#000000', size: 16, usesPressure: false }, 's')
    const item = toPaperItem(mapOf(s), 's') as paper.Path | paper.CompoundPath
    expect(Math.abs(item.area)).toBeGreaterThan(0)
    const result = combine(mapOf(s, rect(-50, -50, 40, 40, FILLED, 'r')), ['s', 'r'], 'union')
    expect(result).not.toBeNull()
    expect(covers(mapOf(result!), 's', [-30, -30])).toBe(true)
    expect(covers(mapOf(result!), 's', [50, 5])).toBe(true)
  })

  it('keeps a gradient fill of the bottom shape where it was on the canvas', () => {
    const paint: Paint = {
      kind: 'linear',
      stops: [
        { offset: 0, color: '#000000', opacity: 1 },
        { offset: 1, color: '#ffffff', opacity: 1 },
      ],
      start: [0, 0],
      end: [1, 1],
    }
    const r = {
      ...rect(0, 0, 100, 50, { ...FILLED, fill: paint }, 'r'),
      transform: { x: 100, y: 100, rotation: 30, scaleX: 1, scaleY: 1 },
    }
    // The circle sticks out of the rectangle, so the result's box is larger.
    const nodes = mapOf(r, circle(300, 100, 80, FILLED, 'c'))
    const result = combine(nodes, ['r', 'c'], 'union')!
    expect(fillBox(result)).not.toEqual(fillBox(r))

    // The gradient's ends on the canvas, along the lines its colors change along.
    const ends = (node: VectorNode) => {
      const placed = placeGradient(
        node.style.fill as Extract<Paint, { kind: 'linear' }>,
        fillBox(node)!,
      )!
      if (placed.kind !== 'linear') throw new Error('not linear')
      return [placed.start, placed.end].map(([x, y]) => applyTransform(node.transform, x, y))
    }
    const [s0, e0] = ends(r)
    const [s1, e1] = ends(result)
    // The start stays put, and so does the direction and length of the color change.
    expect(s1[0]).toBeCloseTo(s0[0], 3)
    expect(s1[1]).toBeCloseTo(s0[1], 3)
    expect(e1[0]).toBeCloseTo(e0[0], 3)
    expect(e1[1]).toBeCloseTo(e0[1], 3)
  })

  it('keeps a radial gradient centered where it was', () => {
    const paint: Paint = {
      kind: 'radial',
      stops: [
        { offset: 0, color: '#000000', opacity: 1 },
        { offset: 1, color: '#ffffff', opacity: 1 },
      ],
      center: [0.5, 0.5],
      radius: 0.5,
    }
    const c = circle(100, 100, 50, { ...FILLED, fill: paint }, 'c')
    const nodes = mapOf(c, rect(100, 100, 200, 30, FILLED, 'r'))
    const result = combine(nodes, ['c', 'r'], 'union')!
    const placed = placeGradient(
      result.style.fill as Extract<Paint, { kind: 'radial' }>,
      fillBox(result)!,
    )!
    if (placed.kind !== 'radial') throw new Error('not radial')
    const [cx, cy] = applyTransform(result.transform, ...placed.center)
    expect(cx).toBeCloseTo(100, 3)
    expect(cy).toBeCloseTo(100, 3)
    expect(placed.radius).toBeCloseTo(50, 3)
  })
})

describe('simplifyPath', () => {
  it('cuts the anchors of a boolean result of a freehand stroke, keeping its shape', () => {
    const s = stroke(0, 600, 100, 's')
    const result = combine(mapOf(s, rect(-100, 0, 50, 200, FILLED, 'r')), ['s', 'r'], 'union')!
    const simpler = simplifyPath(result)!
    expect(anchorCount(simpler)).toBeLessThan(anchorCount(result) / 2)
    // Within the 2.5-unit tolerance of the shape: the ink's box moves at most that much.
    const before = inkBounds(mapOf(result), 's')!
    const after = inkBounds(mapOf(simpler), 's')!
    for (const side of ['minX', 'minY', 'maxX', 'maxY'] as const) {
      expect(Math.abs(after[side] - before[side])).toBeLessThan(3)
    }
    const out = mapOf(simpler)
    expect(covers(out, 's', [300, 100])).toBe(true)
    expect(covers(out, 's', [-75, 150])).toBe(true)
    expect(covers(out, 's', [300, 150])).toBe(false)
    // Every segment is still a proper cubic.
    for (const c of simpler.contours)
      expect(pathSegments(c.anchors, c.closed).length).toBeGreaterThan(1)
  })

  it('leaves a path that is already simple alone', () => {
    const result = combine(
      mapOf(rect(0, 0, 200, 100, FILLED, 'r'), circle(100, 50, 30, FILLED, 'c')),
      ['r', 'c'],
      'subtract',
    )!
    expect(simplifyPath(result)).toBeNull()
  })

  it('keeps corners sharp and straight sides straight', () => {
    // A wavy stroke from inside a rectangle out past its right side.
    const points: Point[] = []
    for (let x = 100; x <= 700; x += 10) points.push([x, 100 + 20 * Math.sin(x / 40), 0.5])
    const s = createStrokeNode(points, { color: '#000000', size: 20, usesPressure: false }, 's')
    const result = combine(mapOf(rect(0, 0, 200, 200, FILLED, 'r'), s), ['r', 's'], 'union')!
    const simpler = simplifyPath(result)!
    expect(anchorCount(simpler)).toBeLessThan(anchorCount(result) / 2)

    const anchors = simpler.contours[0].anchors
    // The rectangle's corners are still anchors with no handles, where they were.
    for (const [x, y] of [
      [0, 0],
      [200, 0],
      [200, 200],
      [0, 200],
    ]) {
      const at = anchors.find((a) => a.x === x && a.y === y)
      expect(at).toMatchObject({ kind: 'corner', inX: 0, inY: 0, outX: 0, outY: 0 })
    }
    // Its left side is still one straight segment.
    const segments = pathSegments(anchors, true)
    const left = segments.find(([p0, , , p3]) => p0[0] === 0 && p3[0] === 0)
    expect(left).toEqual([
      [0, 200],
      [0, 200],
      [0, 0],
      [0, 0],
    ])
  })
})
