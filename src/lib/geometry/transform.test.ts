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
import { bakeTransform, normalizeRotation } from './transform'

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
