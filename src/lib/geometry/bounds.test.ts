import { describe, expect, it } from 'vitest'
import {
  createEllipseNode,
  createLineNode,
  createRectNode,
  createStrokeNode,
} from '../../store/editorStore'
import type { Style, Transform, VectorNode } from '../../types'
import { applyTransform, arrowHeadSize, invertTransform, nodeBounds } from './bounds'

const outlined: Style = { fill: null, stroke: '#000000', strokeWidth: 4, opacity: 1 }
const filledOnly: Style = { fill: '#ef4444', stroke: null, strokeWidth: 4, opacity: 1 }
const box = { x: 100, y: 200, width: 300, height: 100 }

const at = (node: VectorNode, transform: Partial<Transform>): VectorNode => ({
  ...node,
  transform: { ...node.transform, ...transform },
})

/** The box with every value rounded, so float noise from turning doesn't matter. */
function roundedBounds(node: VectorNode) {
  const b = nodeBounds(node)
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

  it('has no bounds for node types without them yet', () => {
    const path = { ...createRectNode(box, outlined), type: 'path', anchors: [], closed: false }

    expect(nodeBounds(path as VectorNode)).toBeNull()
  })
})
