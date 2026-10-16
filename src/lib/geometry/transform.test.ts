import { describe, expect, it } from 'vitest'
import { createStrokeNode } from '../../store/editorStore'
import {
  IDENTITY_TRANSFORM,
  type Anchor,
  type BaseNode,
  type NodeOf,
  type Point,
  type Transform,
} from '../../types'
import {
  absoluteTransform,
  bakeTransform,
  bakeTransforms,
  composeTransform,
  deltaInParent,
  isAxisAligned,
  normalizeRotation,
  relativeTransform,
  scaleAlong,
  snapAngle,
} from './transform'

const base: BaseNode = {
  id: 'n',
  name: 'Node',
  parentId: null,
  transform: IDENTITY_TRANSFORM,
  style: { fill: '#000000', stroke: null, strokeWidth: 1, opacity: 1 },
  hidden: false,
  locked: false,
}

/** What a Transformer leaves after moving to (10, 20), turning 30° and scaling 2 × 3. */
const resized: Transform = { x: 10, y: 20, rotation: 30, scaleX: 2, scaleY: 3 }
const baked: Transform = { ...resized, scaleX: 1, scaleY: 1 }

describe('normalizeRotation', () => {
  it('keeps degrees in (-180, 180] without float noise', () => {
    expect(normalizeRotation(30)).toBe(30)
    expect(normalizeRotation(390)).toBe(30)
    expect(normalizeRotation(-190)).toBe(170)
    expect(normalizeRotation(180)).toBe(180)
    expect(normalizeRotation(-180)).toBe(180)
    expect(normalizeRotation(89.99999999999999)).toBe(90)
    expect(Object.is(normalizeRotation(-360), 0)).toBe(true)
  })
})

describe('snapAngle', () => {
  it('swings the point to the nearest 45° around the origin, keeping its distance', () => {
    const [x1, y1] = snapAngle([10, 10], [110, 15])
    expect(x1).toBeCloseTo(10 + Math.hypot(100, 5), 6)
    expect(y1).toBe(10)

    const [x2, y2] = snapAngle([0, 0], [100, 90])
    expect(x2).toBeCloseTo(Math.hypot(100, 90) / Math.SQRT2, 6)
    expect(y2).toBeCloseTo(x2, 6)
  })

  it('leaves no float noise on the snapped axis', () => {
    const [x, y] = snapAngle([5, 5], [5.2, -95])
    expect(x).toBe(5)
    expect(y).toBeCloseTo(5 - Math.hypot(0.2, 100), 6)
  })
})

describe('bakeTransform', () => {
  it('keeps a freehand stroke scaled, since its outline is a fill', () => {
    const points: Point[] = [[0, 0, 0.5]]
    const stroke = createStrokeNode(points, { color: '#000000', size: 8, usesPressure: false })

    expect(bakeTransform(stroke, resized)).toEqual({ transform: resized })
  })

  it('returns null when nothing changed', () => {
    const stroke = createStrokeNode([[0, 0, 0.5]], {
      color: '#000000',
      size: 8,
      usesPressure: false,
    })
    expect(bakeTransform(stroke, { ...IDENTITY_TRANSFORM })).toBeNull()
  })

  it('bakes scale into rect and ellipse sizes', () => {
    const rect: NodeOf<'rect'> = { ...base, type: 'rect', width: 100, height: 50, cornerRadius: 8 }
    const ellipse: NodeOf<'ellipse'> = { ...base, type: 'ellipse', rx: 40, ry: 20 }

    expect(bakeTransform(rect, resized)).toEqual({ transform: baked, width: 200, height: 150 })
    expect(bakeTransform(ellipse, resized)).toEqual({ transform: baked, rx: 80, ry: 60 })
  })

  it('bakes scale into line points and path anchors with their handles', () => {
    const line: NodeOf<'line'> = {
      ...base,
      type: 'line',
      points: [0, 0, 10, -5],
      arrowStart: false,
      arrowEnd: true,
    }
    const anchor: Anchor = { x: 1, y: 2, inX: -3, inY: 0, outX: 3, outY: 1, kind: 'smooth' }
    const path: NodeOf<'path'> = { ...base, type: 'path', anchors: [anchor], closed: false }

    expect(bakeTransform(line, resized)).toEqual({ transform: baked, points: [0, 0, 20, -15] })
    expect(bakeTransform(path, resized)).toEqual({
      transform: baked,
      anchors: [{ x: 2, y: 6, inX: -6, inY: 0, outX: 6, outY: 3, kind: 'smooth' }],
    })
  })

  it('widens text from a side handle and scales its font from a corner', () => {
    const text: NodeOf<'text'> = {
      ...base,
      type: 'text',
      text: 'Hi',
      fontFamily: 'Arial',
      fontSize: 20,
      fontStyle: 'normal',
      align: 'left',
      width: 100,
    }

    expect(bakeTransform(text, { ...IDENTITY_TRANSFORM, scaleX: 1.5 })).toMatchObject({
      width: 150,
      fontSize: 20,
    })
    expect(bakeTransform(text, { ...IDENTITY_TRANSFORM, scaleX: 2, scaleY: 2 })).toMatchObject({
      width: 200,
      fontSize: 40,
    })
  })

  it('only moves a shape that was moved or turned without scaling', () => {
    const rect: NodeOf<'rect'> = { ...base, type: 'rect', width: 100, height: 50, cornerRadius: 0 }
    expect(bakeTransform(rect, baked)).toEqual({ transform: baked })
  })
})

// Rounded, so float noise from turning doesn't matter; `|| 0` turns -0 into 0.
const round = (t: Transform) =>
  Object.fromEntries(Object.entries(t).map(([k, v]) => [k, Math.round(v * 1e6) / 1e6 || 0]))

describe('transforms through groups', () => {
  const parent: Transform = { x: 100, y: 50, rotation: 90, scaleX: 1, scaleY: 1 }
  const child: Transform = { x: 10, y: 0, rotation: 30, scaleX: 2, scaleY: 1 }

  it('composes a child transform with its parent, and takes it apart again', () => {
    const absolute = composeTransform(parent, child)
    expect(round(absolute)).toEqual({ x: 100, y: 60, rotation: 120, scaleX: 2, scaleY: 1 })
    expect(round(relativeTransform(parent, absolute))).toEqual(child)
  })

  it('sees a parent scale along a turned child axes', () => {
    expect(scaleAlong(2, 3, 0)).toEqual([2, 3])
    expect(scaleAlong(2, 3, 90)).toEqual([3, 2])
    expect(scaleAlong(2, 2, 30)).toEqual([2, 2])
  })

  it('finds a node transform on the canvas and moves it along the canvas', () => {
    const group = { ...base, id: 'g', type: 'group' as const, childIds: ['c'], transform: parent }
    const rect: NodeOf<'rect'> = {
      ...base,
      id: 'c',
      parentId: 'g',
      transform: child,
      type: 'rect',
      width: 10,
      height: 10,
      cornerRadius: 0,
    }
    const nodes = { g: group, c: rect }

    expect(round(absoluteTransform(nodes, 'c'))).toEqual(round(composeTransform(parent, child)))
    expect(absoluteTransform(nodes, 'g')).toBe(parent)
    // The group is turned a quarter, so moving right on the canvas is moving up in the group.
    const [dx, dy] = deltaInParent(nodes, 'c', 5, 0)
    expect([Math.round(dx * 1e6) / 1e6 || 0, Math.round(dy * 1e6) / 1e6]).toEqual([0, -5])
  })
})

describe('bakeTransforms', () => {
  const rect: NodeOf<'rect'> = {
    ...base,
    id: 'r',
    parentId: 'g',
    transform: { ...IDENTITY_TRANSFORM, x: 10, y: 20 },
    type: 'rect',
    width: 100,
    height: 50,
    cornerRadius: 0,
  }
  const stroke = {
    ...createStrokeNode([[0, 0, 0.5]], { color: '#000000', size: 8, usesPressure: false }, 's'),
    parentId: 'g',
    transform: { ...IDENTITY_TRANSFORM, rotation: 90 },
  }
  const group = { ...base, id: 'g', type: 'group' as const, childIds: ['r', 's'] }
  const nodes = { g: group, r: rect, s: stroke }

  it('passes a group scale to its children, so the group keeps a scale of 1', () => {
    const next = { x: 5, y: 5, rotation: 0, scaleX: 2, scaleY: 3 }

    expect(bakeTransforms(nodes, group, next)).toEqual({
      g: { transform: { ...next, scaleX: 1, scaleY: 1 } },
      r: { transform: { ...IDENTITY_TRANSFORM, x: 20, y: 60 }, width: 200, height: 150 },
      // Turned a quarter, the stroke sees the group's scale with its axes swapped.
      s: { transform: { ...IDENTITY_TRANSFORM, rotation: 90, scaleX: 3, scaleY: 2 } },
    })
  })

  it('only moves a group that was moved or turned', () => {
    const next = { ...IDENTITY_TRANSFORM, x: 5, rotation: 45 }
    expect(bakeTransforms(nodes, group, next)).toEqual({ g: { transform: next } })
    expect(bakeTransforms(nodes, rect, rect.transform)).toEqual({})
  })

  it('tells whether everything in a group is turned by multiples of 90°', () => {
    expect(isAxisAligned(nodes, 'g')).toBe(true)
    expect(
      isAxisAligned(
        { ...nodes, r: { ...rect, transform: { ...rect.transform, rotation: 30 } } },
        'g',
      ),
    ).toBe(false)
  })
})
