import { describe, expect, it } from 'vitest'
import {
  DEFAULT_TEXT_STYLE,
  createEllipseNode,
  createGroupNode,
  createLineNode,
  createPathFromContours,
  createPathNode,
  createRectNode,
  createStrokeNode,
  createTextNode,
} from '../../store/editorStore'
import { solid } from '../paint/paint'
import type { FillRule, Point, Style, VectorNode } from '../../types'
import { arrowHeadSize, type Vec } from './bounds'
import {
  distToSegment,
  nearestOnPath,
  nodeHitsSegment,
  pointInPolygon,
  pointInPolygons,
  segmentsDistance,
} from './hitTest'
import { corner } from './pathData'

/** A size-8 horizontal stroke from (0, 0) to (100, 0). */
const stroke = (overrides: Partial<VectorNode> = {}) =>
  ({
    ...createStrokeNode(
      [
        [0, 0, 0.5],
        [50, 0, 0.5],
        [100, 0, 0.5],
      ] as Point[],
      { color: '#000000', size: 8, usesPressure: false },
    ),
    ...overrides,
  }) as VectorNode

describe('distances', () => {
  it('measures to the nearest point of a segment', () => {
    expect(distToSegment(50, 10, [0, 0], [100, 0])).toBe(10)
    expect(distToSegment(-30, 40, [0, 0], [100, 0])).toBe(50)
    expect(distToSegment(3, 4, [0, 0], [0, 0])).toBe(5)
  })

  it('is zero for crossing segments', () => {
    expect(segmentsDistance([0, -10], [0, 10], [-10, 0], [10, 0])).toBe(0)
    expect(segmentsDistance([0, 0], [10, 0], [0, 5], [10, 5])).toBe(5)
  })
})

describe('nodeHitsSegment', () => {
  it('hits when the eraser circle reaches the ink', () => {
    // Eraser radius 5 + brush radius 4 = 9.
    expect(nodeHitsSegment(stroke(), [50, 8], [50, 8], 5)).toBe(true)
    expect(nodeHitsSegment(stroke(), [50, 10], [50, 10], 5)).toBe(false)
  })

  it('hits a stroke crossed between two samples of a fast swipe', () => {
    expect(nodeHitsSegment(stroke(), [50, -200], [50, 200], 1)).toBe(true)
  })

  it('follows the node transform', () => {
    const moved = stroke({ transform: { x: 0, y: 300, rotation: 0, scaleX: 1, scaleY: 1 } })
    const turned = stroke({ transform: { x: 0, y: 0, rotation: 90, scaleX: 1, scaleY: 1 } })

    expect(nodeHitsSegment(moved, [50, 0], [50, 0], 5)).toBe(false)
    expect(nodeHitsSegment(moved, [50, 300], [50, 300], 5)).toBe(true)
    expect(nodeHitsSegment(turned, [0, 80], [0, 80], 5)).toBe(true)
  })

  it('touches a text anywhere in its box, and never a group itself', () => {
    // One line at size 20 is 24 units tall.
    const text = createTextNode(0, 0, 100, { ...DEFAULT_TEXT_STYLE, fontSize: 20 }, 'Hi')

    expect(nodeHitsSegment(text, [90, 12], [90, 12], 1)).toBe(true)
    expect(nodeHitsSegment(text, [50, 40], [50, 40], 1)).toBe(false)
    expect(nodeHitsSegment(text, [50, 40], [50, 40], 20)).toBe(true)
    expect(nodeHitsSegment(createGroupNode(['a']), [0, 0], [0, 0], 50)).toBe(false)
  })
})

describe('pointInPolygon', () => {
  const square: Vec[] = [
    [0, 0],
    [10, 0],
    [10, 10],
    [0, 10],
  ]

  it('tells inside from outside', () => {
    expect(pointInPolygon([5, 5], square)).toBe(true)
    expect(pointInPolygon([15, 5], square)).toBe(false)
    expect(pointInPolygon([5, -1], square)).toBe(false)
  })
})

describe('nodeHitsSegment on shapes', () => {
  const outline: Style = { fill: null, stroke: '#000000', strokeWidth: 4, opacity: 1 }
  const filled: Style = { ...outline, fill: solid('#ef4444') }
  const box = { x: 0, y: 0, width: 200, height: 100 }

  it('touches an unfilled rectangle only on its outline', () => {
    const rect = createRectNode(box, outline)

    expect(nodeHitsSegment(rect, [100, 50], [120, 50], 5)).toBe(false)
    // Eraser radius 5 + half the outline 2 = 7 from the edge.
    expect(nodeHitsSegment(rect, [100, 6], [100, 6], 5)).toBe(true)
    expect(nodeHitsSegment(rect, [100, 8], [100, 8], 5)).toBe(false)
    expect(nodeHitsSegment(rect, [100, -6], [100, -6], 5)).toBe(true)
    // A swipe right across the box crosses its sides.
    expect(nodeHitsSegment(rect, [-50, 50], [250, 50], 1)).toBe(true)
  })

  it('touches a filled rectangle anywhere inside', () => {
    expect(nodeHitsSegment(createRectNode(box, filled), [100, 50], [120, 50], 5)).toBe(true)
  })

  it('follows rounded corners', () => {
    const rect = { ...createRectNode(box, filled), cornerRadius: 40 }
    // Inside the square corner, outside the rounded one.
    expect(nodeHitsSegment(rect, [3, 3], [3, 3], 1)).toBe(false)
    expect(nodeHitsSegment({ ...rect, cornerRadius: 0 }, [3, 3], [3, 3], 1)).toBe(true)
  })

  it('touches an ellipse by its outline, or inside when filled', () => {
    const ring = createEllipseNode(box, outline) // center (100, 50), radii 100 × 50

    expect(nodeHitsSegment(ring, [100, 50], [100, 50], 5)).toBe(false)
    expect(nodeHitsSegment(ring, [198, 50], [198, 50], 1)).toBe(true)
    // The box corner is outside the ellipse.
    expect(nodeHitsSegment(createEllipseNode(box, filled), [8, 8], [8, 8], 1)).toBe(false)
    expect(nodeHitsSegment(createEllipseNode(box, filled), [100, 50], [100, 50], 1)).toBe(true)
  })

  it('touches a line within half its width, and its arrowheads', () => {
    const line = createLineNode([0, 0], [200, 0], outline)
    const head = arrowHeadSize(4)

    expect(nodeHitsSegment(line, [100, 6], [100, 6], 5)).toBe(true)
    expect(nodeHitsSegment(line, [100, 8], [100, 8], 5)).toBe(false)
    // Beside the tip, where only an arrowhead reaches.
    const beside: Vec = [200 - head + 1, head / 2 - 1]
    expect(nodeHitsSegment(line, beside, beside, 1)).toBe(false)
    expect(nodeHitsSegment({ ...line, arrowEnd: true }, beside, beside, 1)).toBe(true)
    expect(nodeHitsSegment({ ...line, arrowStart: true }, beside, beside, 1)).toBe(false)
  })

  it('follows the shape transform', () => {
    const rect = createRectNode({ x: 500, y: 500, width: 200, height: 100 }, filled)
    const turned = { ...rect, transform: { ...rect.transform, rotation: 90 } }

    expect(nodeHitsSegment(rect, [600, 550], [600, 550], 1)).toBe(true)
    // Turned about its corner, it covers x 400..500 and y 500..700.
    expect(nodeHitsSegment(turned, [600, 550], [600, 550], 1)).toBe(false)
    expect(nodeHitsSegment(turned, [450, 650], [450, 650], 1)).toBe(true)
  })
})

describe('paths', () => {
  const outline: Style = { fill: null, stroke: '#000000', strokeWidth: 4, opacity: 1 }
  const filled: Style = { ...outline, fill: solid('#ef4444') }

  /** An arch from (100, 100) up to (150, 25) and down to (200, 100), its handles 100 tall. */
  const arch = (style: Style) =>
    createPathNode(
      [
        { ...corner(100, 100), outY: -100 },
        { ...corner(200, 100), inY: -100 },
      ],
      false,
      style,
    )

  it('touches an unfilled path only on its curve, within half its outline', () => {
    // Eraser radius 5 + half the outline 2 = 7 from the curve's top at (150, 25).
    expect(nodeHitsSegment(arch(outline), [150, 31], [150, 31], 5)).toBe(true)
    expect(nodeHitsSegment(arch(outline), [150, 34], [150, 34], 5)).toBe(false)
    // The handles reach y = 0, the curve doesn't.
    expect(nodeHitsSegment(arch(outline), [150, 5], [150, 5], 5)).toBe(false)
    expect(nodeHitsSegment(arch(outline), [150, 80], [150, 80], 5)).toBe(false)
    expect(nodeHitsSegment(arch(outline), [150, -50], [150, 200], 1)).toBe(true)
  })

  it('fills an open path as if it were closed', () => {
    expect(nodeHitsSegment(arch(filled), [150, 80], [150, 80], 1)).toBe(true)
    expect(nodeHitsSegment(arch(filled), [150, 110], [150, 110], 1)).toBe(false)
  })

  it('follows the path transform', () => {
    const path = arch(outline)
    // Turned half a turn about its first anchor, the top lands at (50, 175).
    const turned = { ...path, transform: { ...path.transform, rotation: 180 } }

    expect(nodeHitsSegment(turned, [50, 175], [50, 175], 1)).toBe(true)
    expect(nodeHitsSegment(turned, [150, 25], [150, 25], 1)).toBe(false)
  })

  it('finds the nearest point of the outline, by segment and position along it', () => {
    const near = nearestOnPath(arch(outline), [150, 0])!

    expect(near.contour).toBe(0)
    expect(near.segment).toBe(0)
    expect(near.t).toBeCloseTo(0.5, 2)
    expect(near.distance).toBeCloseTo(25, 1)
    expect(nearestOnPath({ ...arch(outline), contours: [] }, [0, 0])).toBeNull()
  })

  /** Two squares, 0–100 and 25–75, the inner one turning `inner` way round. */
  const donut = (rule: FillRule, inner: 'same' | 'reverse') => {
    const square = (from: number, to: number) => [
      corner(from, from),
      corner(to, from),
      corner(to, to),
      corner(from, to),
    ]
    const hole = square(25, 75)
    return createPathFromContours(
      [
        { anchors: square(0, 100), closed: true },
        { anchors: inner === 'same' ? hole : hole.reverse(), closed: true },
      ],
      filled,
      rule,
    )
  }

  it('leaves the hole of a path with several contours unfilled, by its fill rule', () => {
    // Even-odd: the inner square is a hole whichever way it turns.
    expect(nodeHitsSegment(donut('evenodd', 'same'), [50, 50], [50, 50], 1)).toBe(false)
    expect(nodeHitsSegment(donut('evenodd', 'same'), [12, 50], [12, 50], 1)).toBe(true)
    // Nonzero: only an inner contour turning the other way cuts a hole.
    expect(nodeHitsSegment(donut('nonzero', 'reverse'), [50, 50], [50, 50], 1)).toBe(false)
    expect(nodeHitsSegment(donut('nonzero', 'same'), [50, 50], [50, 50], 1)).toBe(true)
    // The hole's edge is ink.
    expect(nodeHitsSegment(donut('evenodd', 'same'), [50, 27], [50, 27], 1)).toBe(true)
  })

  it('finds the nearest point on any contour', () => {
    const near = nearestOnPath(donut('evenodd', 'same'), [50, 30])!

    expect(near.contour).toBe(1)
    expect(near.segment).toBe(0)
    expect(near.distance).toBeCloseTo(5, 6)
  })
})

describe('pointInPolygons', () => {
  const square = (from: number, to: number): Vec[] => [
    [from, from],
    [to, from],
    [to, to],
    [from, to],
  ]

  it('fills by crossing parity under even-odd, and by winding under nonzero', () => {
    const outer = square(0, 100)
    const same = square(25, 75)
    const reverse = [...same].reverse()

    expect(pointInPolygons([50, 50], [outer, same], 'evenodd')).toBe(false)
    expect(pointInPolygons([50, 50], [outer, reverse], 'evenodd')).toBe(false)
    expect(pointInPolygons([50, 50], [outer, same], 'nonzero')).toBe(true)
    expect(pointInPolygons([50, 50], [outer, reverse], 'nonzero')).toBe(false)
    expect(pointInPolygons([10, 50], [outer, reverse], 'nonzero')).toBe(true)
    expect(pointInPolygons([150, 50], [outer], 'nonzero')).toBe(false)
  })
})
