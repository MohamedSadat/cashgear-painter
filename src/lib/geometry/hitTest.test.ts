import { describe, expect, it } from 'vitest'
import { createStrokeNode } from '../../store/editorStore'
import type { Point, VectorNode } from '../../types'
import { distToSegment, nodeHitsSegment, segmentsDistance } from './hitTest'

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
    const rect = { ...stroke(), type: 'rect', width: 10, height: 10, cornerRadius: 0 }

    expect(nodeHitsSegment(rect as VectorNode, [5, 5], [5, 5], 50)).toBe(false)
  })
})
