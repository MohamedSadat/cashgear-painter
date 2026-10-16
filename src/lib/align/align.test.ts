import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SHAPE_STYLE,
  createEllipseNode,
  createGroupNode,
  createRectNode,
} from '../../store/editorStore'
import type { NodeId, VectorNode } from '../../types'
import { inkBounds, type Box } from '../geometry/bounds'
import { solid } from '../paint/paint'
import { alignPatch, distributePatch, type Patch } from './align'
import { withPatch } from './numeric'

// No outline, so a rect's box is its geometry.
const style = { ...DEFAULT_SHAPE_STYLE, stroke: null, fill: solid('#000000') }
const PAGE: Box = { minX: 0, minY: 0, maxX: 1600, maxY: 1000 }

type Nodes = Record<NodeId, VectorNode>

function rect(id: string, x: number, y: number, width = 100, height = 100, rotation = 0) {
  const node = createRectNode({ x, y, width, height }, style, id)
  return { ...node, transform: { ...node.transform, rotation } }
}

const nodesOf = (...list: VectorNode[]): Nodes => Object.fromEntries(list.map((n) => [n.id, n]))

/** Each node's ink box once the patch is applied. */
const boxesAfter = (nodes: Nodes, patch: Patch, ids: NodeId[]) =>
  ids.map((id) => inkBounds(withPatch(nodes, patch), id)!)

const SQRT_HALF = Math.SQRT1_2 * 100 // a 100-unit side turned 45°, along one axis

describe('alignPatch', () => {
  // a: 100–200 × 100–150; b: 300–500 × 250–350; c: 50–100 × 400–450.
  const nodes = nodesOf(
    rect('a', 100, 100, 100, 50),
    rect('b', 300, 250, 200),
    rect('c', 50, 400, 50, 50),
  )
  const ids = ['a', 'b', 'c']

  it.each([
    ['left', (b: Box) => b.minX, 50],
    ['center', (b: Box) => (b.minX + b.maxX) / 2, 275],
    ['right', (b: Box) => b.maxX, 500],
    ['top', (b: Box) => b.minY, 100],
    ['middle', (b: Box) => (b.minY + b.maxY) / 2, 275],
    ['bottom', (b: Box) => b.maxY, 450],
  ] as const)('lines several objects up on the %s of the box around them', (where, line, at) => {
    const patch = alignPatch(nodes, ids, where, PAGE)
    const after = boxesAfter(nodes, patch, ids)
    for (const box of after) expect(line(box)).toBeCloseTo(at, 9)
    // Only along its own axis.
    const horizontal = where === 'left' || where === 'center' || where === 'right'
    after.forEach((box, i) => {
      const before = inkBounds(nodes, ids[i])!
      if (horizontal) expect(box.minY).toBe(before.minY)
      else expect(box.minX).toBe(before.minX)
    })
  })

  it('lines a single object up with the page', () => {
    const one = nodesOf(rect('a', 100, 100, 100, 50))
    expect(boxesAfter(one, alignPatch(one, ['a'], 'right', PAGE), ['a'])[0].maxX).toBe(1600)
    const [box] = boxesAfter(one, alignPatch(one, ['a'], 'middle', PAGE), ['a'])
    expect((box.minY + box.maxY) / 2).toBe(500)
    expect(box.minX).toBe(100)
  })

  it('aligns rotated objects by their axis-aligned boxes', () => {
    // b, a 100-unit square turned 45° about its top-left corner at (500, 300), spans
    // 500 ± 70.7 across and 300 to 441.4 down.
    const turned = nodesOf(rect('a', 100, 100), rect('b', 500, 300, 100, 100, 45), {
      ...createEllipseNode({ x: 800, y: 600, width: 200, height: 100 }, style, 'c'),
      transform: { x: 900, y: 650, rotation: 30, scaleX: 1, scaleY: 1 },
    })
    const ids = ['a', 'b', 'c']
    const left = alignPatch(turned, ids, 'left', PAGE)
    const after = withPatch(turned, left)
    for (const id of ids) expect(inkBounds(after, id)!.minX).toBeCloseTo(100, 9)
    expect(after.b.transform).toMatchObject({ x: 100 + SQRT_HALF, y: 300, rotation: 45 })
    expect(after.c.transform.rotation).toBe(30)

    const bottom = alignPatch(turned, ids, 'bottom', PAGE)
    const ellipse = inkBounds(turned, 'c')!
    for (const box of boxesAfter(turned, bottom, ids)) expect(box.maxY).toBeCloseTo(ellipse.maxY, 9)
  })

  it('leaves locked objects in place and lines the others up with them', () => {
    const nodes = nodesOf(
      rect('a', 100, 100),
      { ...rect('l', 300, 200), locked: true },
      rect('c', 600, 300),
    )
    const patch = alignPatch(nodes, ['a', 'l', 'c'], 'left', PAGE)
    expect(Object.keys(patch).sort()).toEqual(['a', 'c'])
    for (const box of boxesAfter(nodes, patch, ['a', 'l', 'c'])) expect(box.minX).toBe(300)
    // A locked object alone doesn't move.
    expect(alignPatch(nodes, ['l'], 'left', PAGE)).toEqual({})
  })

  it('moves an object in a turned group along the canvas', () => {
    // The group is turned 90° about (800, 100), so its 100 × 50 child lies at x 750–800,
    // y 100–200.
    const group = {
      ...createGroupNode(['k'], null, 'g'),
      transform: { x: 800, y: 100, rotation: 90, scaleX: 1, scaleY: 1 },
    }
    const nodes = nodesOf(rect('a', 100, 300), group, {
      ...rect('k', 0, 0, 100, 50),
      parentId: 'g',
    })
    expect(inkBounds(nodes, 'k')).toMatchObject({ minX: 750, maxX: 800 })
    const patch = alignPatch(nodes, ['a', 'k'], 'left', PAGE)
    const [, k] = boxesAfter(nodes, patch, ['a', 'k'])
    expect(k.minX).toBeCloseTo(100, 9)
    expect(k.minY).toBeCloseTo(100, 9)
    expect(patch.g).toBeUndefined()
  })

  it('changes nothing when the objects are aligned already', () => {
    const nodes = nodesOf(rect('a', 100, 100), rect('b', 100, 400, 50, 50))
    expect(alignPatch(nodes, ['a', 'b'], 'left', PAGE)).toEqual({})
  })
})

describe('distributePatch', () => {
  it('makes the gaps between 3 or more objects equal; the outer ones stay put', () => {
    // Given out of order: they go by their centers.
    const nodes = nodesOf(
      rect('c', 400, 100, 100),
      rect('a', 0, 300, 100),
      rect('d', 900, 500, 100),
      rect('b', 120, 700, 50),
    )
    const ids = ['c', 'a', 'd', 'b']
    const patch = distributePatch(nodes, ids, 'x')
    expect(Object.keys(patch).sort()).toEqual(['b', 'c'])
    const [c, a, d, b] = boxesAfter(nodes, patch, ids)
    const gap = (900 - 100 - 150) / 3
    expect(b.minX - a.maxX).toBeCloseTo(gap, 9)
    expect(c.minX - b.maxX).toBeCloseTo(gap, 9)
    expect(d.minX - c.maxX).toBeCloseTo(gap, 9)
    // Along x only.
    expect(b.minY).toBe(700)
  })

  it('distributes vertically by axis-aligned boxes, rotated objects too', () => {
    const nodes = nodesOf(
      rect('a', 100, 0, 100, 100),
      rect('b', 300, 150, 100, 100, 45),
      rect('c', 500, 800, 100, 100),
    )
    const patch = distributePatch(nodes, ['a', 'b', 'c'], 'y')
    const [a, b, c] = boxesAfter(nodes, patch, ['a', 'b', 'c'])
    expect(b.maxY - b.minY).toBeCloseTo(2 * SQRT_HALF, 9)
    expect(b.minY - a.maxY).toBeCloseTo(c.minY - b.maxY, 9)
    expect(withPatch(nodes, patch).b.transform.rotation).toBe(45)
  })

  it('does nothing for fewer than 3 objects', () => {
    const nodes = nodesOf(rect('a', 0, 0), rect('b', 500, 0))
    expect(distributePatch(nodes, ['a', 'b'], 'x')).toEqual({})
  })

  it('keeps locked objects in place and spaces the others evenly on each side of them', () => {
    const nodes = nodesOf(
      rect('a', 0, 0),
      rect('b', 110, 0),
      { ...rect('l', 500, 0), locked: true },
      rect('c', 620, 0),
      rect('d', 900, 0),
    )
    const ids = ['a', 'b', 'l', 'c', 'd']
    const patch = distributePatch(nodes, ids, 'x')
    expect(patch.l).toBeUndefined()
    const [a, b, l, c, d] = boxesAfter(nodes, patch, ids)
    expect(b.minX - a.maxX).toBeCloseTo(150, 9)
    expect(l.minX - b.maxX).toBeCloseTo(150, 9)
    expect(c.minX - l.maxX).toBeCloseTo(100, 9)
    expect(d.minX - c.maxX).toBeCloseTo(100, 9)
  })

  it('changes nothing when the gaps are equal already', () => {
    const nodes = nodesOf(rect('a', 0, 0), rect('b', 200, 0), rect('c', 400, 0))
    expect(distributePatch(nodes, ['a', 'b', 'c'], 'x')).toEqual({})
  })
})
