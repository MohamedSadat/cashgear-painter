import { describe, expect, it } from 'vitest'
import {
  createEllipseNode,
  createLineNode,
  createRectNode,
  createStrokeNode,
} from '../../store/editorStore'
import type { Point, Style, VectorNode } from '../../types'
import { arrowHeadSize, type Vec } from './bounds'
import { distToSegment, nodeHitsSegment, pointInPolygon, segmentsDistance } from './hitTest'

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

  it('never hits node types without hit tests yet', () => {
    const path = { ...stroke(), type: 'path', anchors: [], closed: false }

    expect(nodeHitsSegment(path as VectorNode, [5, 5], [5, 5], 50)).toBe(false)
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
  const filled: Style = { ...outline, fill: '#ef4444' }
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
