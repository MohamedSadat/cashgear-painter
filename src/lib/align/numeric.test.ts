import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SHAPE_STYLE,
  DEFAULT_TEXT_STYLE,
  createGroupNode,
  createRectNode,
  createStrokeNode,
  createTextNode,
} from '../../store/editorStore'
import type { NodeId, NodeOf, Style, VectorNode } from '../../types'
import { applyTransform, inkBounds } from '../geometry/bounds'
import { absoluteTransform } from '../geometry/transform'
import { solid } from '../paint/paint'
import { boxOf } from './align'
import {
  canStretch,
  movePatch,
  resizePatch,
  rotatePatch,
  sharedRotation,
  withPatch,
} from './numeric'

const plain: Style = { ...DEFAULT_SHAPE_STYLE, stroke: null, fill: solid('#000000') }
// A 4-unit outline reaches 2 past the geometry on every side.
const outlined: Style = { ...DEFAULT_SHAPE_STYLE, strokeWidth: 4 }

type Nodes = Record<NodeId, VectorNode>
const nodesOf = (...list: VectorNode[]): Nodes => Object.fromEntries(list.map((n) => [n.id, n]))

function rect(id: string, x: number, y: number, width = 100, height = 50, style = plain) {
  return createRectNode({ x, y, width, height }, style, id)
}

const turned = <T extends VectorNode>(node: T, rotation: number): T => ({
  ...node,
  transform: { ...node.transform, rotation },
})

describe('sharedRotation', () => {
  it('is the rotation on the canvas all the nodes share, or null', () => {
    const group = turned(createGroupNode(['k'], null, 'g'), 30)
    const nodes = nodesOf(
      turned(rect('a', 0, 0), 40),
      group,
      { ...turned(rect('k', 0, 0), 10), parentId: 'g' },
      rect('b', 0, 0),
    )
    expect(sharedRotation(nodes, ['a', 'k'])).toBe(40)
    expect(sharedRotation(nodes, ['a', 'b'])).toBeNull()
    expect(sharedRotation(nodes, [])).toBeNull()
  })
})

describe('canStretch', () => {
  it('is false for anything turned on the canvas other than by 90°, and for a single text', () => {
    const nodes = nodesOf(
      rect('a', 0, 0),
      turned(rect('b', 0, 0), 90),
      turned(rect('c', 0, 0), 30),
      turned(createGroupNode(['k'], null, 'g'), 45),
      { ...rect('k', 0, 0), parentId: 'g' },
      createTextNode(0, 0, 200, DEFAULT_TEXT_STYLE, 'Hi', 't'),
    )
    expect(canStretch(nodes, ['a', 'b'])).toBe(true)
    expect(canStretch(nodes, ['a', 'c'])).toBe(false)
    expect(canStretch(nodes, ['k'])).toBe(false)
    expect(canStretch(nodes, ['t'])).toBe(false)
    expect(canStretch(nodes, ['t', 'a'])).toBe(true)
  })
})

describe('movePatch', () => {
  it("puts the box's top-left corner at X and Y, by the ink of a rotated object too", () => {
    const nodes = nodesOf(rect('a', 100, 100, 100, 50, outlined), turned(rect('b', 400, 100), 45))
    const ids = ['a', 'b']
    const patch = movePatch(nodes, ids, 10, null)
    const after = boxOf(withPatch(nodes, patch), ids)!
    expect(after.minX).toBeCloseTo(10, 9)
    expect(after.minY).toBe(boxOf(nodes, ids)!.minY)
    expect(boxOf(withPatch(nodes, movePatch(nodes, ids, null, -20)), ids)!.minY).toBeCloseTo(-20, 9)
  })

  it('leaves locked nodes where they are', () => {
    const nodes = nodesOf(rect('a', 100, 100), { ...rect('b', 300, 100), locked: true })
    expect(Object.keys(movePatch(nodes, ['a', 'b'], 0, 0))).toEqual(['a'])
  })
})

describe('resizePatch', () => {
  it('makes the ink box exactly as wide as asked, outline included, from its left edge', () => {
    // 100 × 50 with a 4-unit outline: the ink is 104 × 54, from (98, 98).
    const nodes = nodesOf(rect('a', 100, 100, 100, 50, outlined))
    const patch = resizePatch(nodes, ['a'], 'x', 208, false)
    const after = withPatch(nodes, patch)
    expect(inkBounds(after, 'a')).toEqual({ minX: 98, minY: 98, maxX: 306, maxY: 152 })
    // The outline keeps its width: the rect takes the rest.
    expect(after.a).toMatchObject({ width: 204, height: 50, style: { strokeWidth: 4 } })
    expect(after.a.transform).toMatchObject({ scaleX: 1, scaleY: 1 })
  })

  it('scales the other side by as much when keeping the ratio', () => {
    const nodes = nodesOf(rect('a', 100, 100, 100, 50, outlined))
    const after = withPatch(nodes, resizePatch(nodes, ['a'], 'y', 106, true))
    const box = inkBounds(after, 'a')!
    expect(box.maxY - box.minY).toBeCloseTo(106, 6)
    expect((after.a as NodeOf<'rect'>).width).toBeCloseTo(204, 6)
    expect(box.minX).toBeCloseTo(98, 9)
  })

  it('finds the scale for several objects with different outlines', () => {
    const thick = { ...outlined, strokeWidth: 20 }
    const nodes = nodesOf(rect('a', 0, 0, 100, 100, thick), rect('b', 300, 200, 50, 50))
    const ids = ['a', 'b']
    const before = boxOf(nodes, ids)!
    const after = boxOf(withPatch(nodes, resizePatch(nodes, ids, 'x', 600, false)), ids)!
    expect(after.maxX - after.minX).toBeCloseTo(600, 6)
    expect(after.minX).toBeCloseTo(before.minX, 9)
    expect(after.minY).toBeCloseTo(before.minY, 9)
    expect(after.maxY).toBeCloseTo(before.maxY, 9)
  })

  it('resizes a rotated object by its axis-aligned box, keeping the ratio', () => {
    const nodes = nodesOf(turned(rect('a', 500, 300, 100, 100, outlined), 30))
    const before = inkBounds(nodes, 'a')!
    const patch = resizePatch(nodes, ['a'], 'x', 300, true)
    const after = withPatch(nodes, patch)
    const box = inkBounds(after, 'a')!
    expect(box.maxX - box.minX).toBeCloseTo(300, 6)
    expect(box.minX).toBeCloseTo(before.minX, 9)
    expect(box.minY).toBeCloseTo(before.minY, 9)
    const a = after.a as NodeOf<'rect'>
    expect(a.width).toBeCloseTo(a.height, 9)
    expect(a.transform).toMatchObject({ rotation: 30, scaleX: 1, scaleY: 1 })
  })

  it('keeps a freehand stroke’s scale in its transform, and bakes a group’s into its children', () => {
    const stroke = createStrokeNode(
      [
        [0, 0, 0.5],
        [100, 0, 0.5],
      ],
      { color: '#000000', size: 8, usesPressure: false },
      's',
    )
    const nodes = nodesOf(stroke, createGroupNode(['k'], null, 'g'), {
      ...rect('k', 300, 0),
      parentId: 'g',
    })
    const ids = ['s', 'g']
    const width = boxOf(nodes, ids)!.maxX - boxOf(nodes, ids)!.minX
    const patch = resizePatch(nodes, ids, 'x', width * 2, true)
    const after = withPatch(nodes, patch)
    const box = boxOf(after, ids)!
    expect(box.maxX - box.minX).toBeCloseTo(width * 2, 6)
    expect(after.s.transform.scaleX).toBeCloseTo(2, 6)
    expect(after.g.transform).toMatchObject({ scaleX: 1, scaleY: 1 })
    expect((after.k as NodeOf<'rect'>).width).toBeCloseTo(200, 6)
  })

  it('refuses a length that is not positive, and changes nothing for the same length', () => {
    const nodes = nodesOf(rect('a', 0, 0))
    expect(resizePatch(nodes, ['a'], 'x', 0, false)).toEqual({})
    expect(resizePatch(nodes, ['a'], 'x', -10, false)).toEqual({})
    expect(resizePatch(nodes, ['a'], 'x', 100, false)).toEqual({})
  })
})

describe('rotatePatch', () => {
  it('turns each object to the angle about its own middle', () => {
    const nodes = nodesOf(rect('a', 100, 100), turned(rect('b', 400, 100), 20))
    const patch = rotatePatch(nodes, ['a', 'b'], 90)
    const after = withPatch(nodes, patch)
    for (const [id, center] of [
      ['a', [150, 125]],
      ['b', applyTransform(nodes.b.transform, 50, 25)],
    ] as const) {
      expect(after[id].transform.rotation).toBe(90)
      const [x, y] = applyTransform(after[id].transform, 50, 25)
      expect(x).toBeCloseTo(center[0], 9)
      expect(y).toBeCloseTo(center[1], 9)
    }
    // Already there: nothing changes.
    expect(rotatePatch(after, ['a', 'b'], 450)).toEqual({})
  })

  it('sets the rotation on the canvas for an object in a turned group', () => {
    const nodes = nodesOf(turned(createGroupNode(['k'], null, 'g'), 30), {
      ...rect('k', 0, 0),
      parentId: 'g',
    })
    const after = withPatch(nodes, rotatePatch(nodes, ['k'], -45))
    expect(absoluteTransform(after, 'k').rotation).toBeCloseTo(-45, 6)
    expect(after.k.transform.rotation).toBeCloseTo(-75, 6)
  })

  it('leaves locked nodes alone', () => {
    const nodes = nodesOf({ ...rect('a', 0, 0), locked: true })
    expect(rotatePatch(nodes, ['a'], 45)).toEqual({})
  })
})
