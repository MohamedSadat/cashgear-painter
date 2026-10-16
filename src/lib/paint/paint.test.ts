import { describe, expect, it } from 'vitest'
import type { Paint } from '../../types'
import {
  fillColor,
  fromBoxUnits,
  gradientFrom,
  isPaint,
  lastStop,
  paintColor,
  placeGradient,
  radiusUnit,
  reverseStops,
  samePaint,
  solid,
  sortedStops,
  stopAt,
  stopCss,
  toBoxUnits,
} from './paint'

const linear: Paint = {
  kind: 'linear',
  stops: [
    { offset: 0, color: '#ef4444', opacity: 1 },
    { offset: 1, color: '#3b82f6', opacity: 0.5 },
  ],
  start: [0, 0],
  end: [1, 0],
}
const radial: Paint = { kind: 'radial', stops: linear.stops, center: [0.5, 0.5], radius: 0.5 }

describe('paint', () => {
  it('stands for a paint by one color: a solid’s own, a gradient’s first stop', () => {
    expect(paintColor(solid('#22c55e'))).toBe('#22c55e')
    expect(paintColor(linear)).toBe('#ef4444')
    expect(paintColor(radial)).toBe('#ef4444')
    expect(fillColor(null)).toBeUndefined()
    expect(fillColor(solid('#000000'))).toBe('#000000')
  })

  it('compares paints by value', () => {
    expect(samePaint(solid('#000000'), solid('#000000'))).toBe(true)
    expect(samePaint(solid('#000000'), solid('#ffffff'))).toBe(false)
    expect(samePaint(null, null)).toBe(true)
    expect(samePaint(null, solid('#000000'))).toBe(false)
    expect(samePaint(linear, structuredClone(linear))).toBe(true)
    expect(samePaint(linear, { ...linear, end: [0, 1] })).toBe(false)
    expect(samePaint(linear, radial)).toBe(false)
    expect(samePaint(radial, { ...radial, stops: linear.stops.slice(0, 1) })).toBe(false)
  })

  it('accepts only paints the editor can draw', () => {
    expect([solid('#000000'), linear, radial].every(isPaint)).toBe(true)
    for (const value of [
      null,
      '#000000',
      { kind: 'solid' },
      { kind: 'pattern', color: '#000000' },
      { ...linear, stops: [] },
      { ...linear, start: [0] },
      { ...radial, radius: Number.NaN },
      { ...linear, stops: [{ offset: 0, color: 1, opacity: 1 }] },
      // Canvas throws on a stop color it can't read, so stops take hex colors only.
      { ...linear, stops: [{ offset: 0, color: 'not a color', opacity: 1 }] },
      { ...radial, stops: [{ offset: 0, color: 'red', opacity: 1 }] },
    ]) {
      expect(isPaint(value)).toBe(false)
    }
  })
})

describe('gradient stops', () => {
  const stops = [
    { offset: 1, color: '#000000', opacity: 1 },
    { offset: 0.5, color: '#ff0000', opacity: 1 },
    { offset: 0.5, color: '#0000ff', opacity: 1 },
    { offset: -0.25, color: '#ffffff', opacity: 0.5 },
  ]

  it('sorts stops by offset within 0..1, keeping the order of stops at one offset', () => {
    expect(sortedStops(stops).map((s) => [s.offset, s.color])).toEqual([
      [0, '#ffffff'],
      [0.5, '#ff0000'],
      [0.5, '#0000ff'],
      [1, '#000000'],
    ])
    expect(paintColor({ ...linear, stops })).toBe('#ffffff')
    expect(lastStop({ ...linear, stops }).color).toBe('#000000')
  })

  it('writes see-through stops as rgba() and opaque ones as they are', () => {
    expect(stopCss({ offset: 0, color: '#3b82f6', opacity: 1 })).toBe('#3b82f6')
    expect(stopCss({ offset: 0, color: '#3b82f6', opacity: 0.5 })).toBe('rgba(59, 130, 246, 0.5)')
    expect(stopCss({ offset: 0, color: '#f00', opacity: 0 })).toBe('rgba(255, 0, 0, 0)')
  })

  it('mixes the color and opacity between stops', () => {
    const two = [
      { offset: 0, color: '#000000', opacity: 0 },
      { offset: 1, color: '#ffffff', opacity: 1 },
    ]
    expect(stopAt(two, 0.5)).toEqual({ offset: 0.5, color: '#808080', opacity: 0.5 })
    expect(stopAt(two, -1)).toEqual({ offset: 0, color: '#000000', opacity: 0 })
    expect(stopAt(linear.stops, 1)).toEqual({ offset: 1, color: '#3b82f6', opacity: 0.5 })
  })

  it('reverses stops, flipping offsets and keeping a hard edge the right way round', () => {
    const reversed = reverseStops(stops)
    expect(reversed.map((s) => [s.offset, s.color])).toEqual([
      [1.25, '#ffffff'],
      [0.5, '#0000ff'],
      [0.5, '#ff0000'],
      [0, '#000000'],
    ])
    expect(reverseStops(reversed)).toEqual(stops)
  })

  it('makes a gradient from a fill: a solid fades to white, or to black from a light color', () => {
    expect(gradientFrom('linear', solid('#ef4444'), '#000000')).toEqual({
      kind: 'linear',
      stops: [
        { offset: 0, color: '#ef4444', opacity: 1 },
        { offset: 1, color: '#ffffff', opacity: 1 },
      ],
      start: [0, 0.5],
      end: [1, 0.5],
    })
    expect(gradientFrom('radial', null, '#fefefe')).toMatchObject({
      kind: 'radial',
      stops: [{ color: '#fefefe' }, { color: '#000000' }],
      center: [0.5, 0.5],
      radius: 0.5,
    })
    // A gradient keeps its stops when its kind changes, and stays as it is otherwise.
    expect(gradientFrom('radial', linear, '#000000')).toMatchObject({ stops: linear.stops })
    expect(gradientFrom('linear', linear, '#000000')).toBe(linear)
  })
})

describe('gradient geometry', () => {
  const box = { minX: -50, minY: 10, maxX: 150, maxY: 110 } // 200 × 100

  it('converts between box units and the box’s own coordinates', () => {
    expect(fromBoxUnits(box, [0, 0])).toEqual([-50, 10])
    expect(fromBoxUnits(box, [0.5, 1])).toEqual([50, 110])
    expect(toBoxUnits(box, [50, 110])).toEqual([0.5, 1])
    expect(radiusUnit(box)).toBe(200)
    // A side of no length counts as 1 unit long, so nothing divides by 0.
    expect(toBoxUnits({ minX: 5, minY: 0, maxX: 5, maxY: 10 }, [7, 5])).toEqual([2, 0.5])
  })

  it('lays a gradient out in pixels: linear ends, a radial center and radius of the longer side', () => {
    expect(placeGradient(linear, box)).toEqual({
      kind: 'linear',
      stops: linear.stops,
      start: [-50, 10],
      end: [150, 10],
    })
    expect(placeGradient(radial, box)).toEqual({
      kind: 'radial',
      stops: linear.stops,
      center: [50, 60],
      radius: 100,
    })
  })

  it('has no layout for a gradient without extent, which paints its last stop', () => {
    expect(placeGradient({ ...linear, end: linear.start }, box)).toBeNull()
    expect(placeGradient({ ...radial, radius: 0 }, box)).toBeNull()
  })
})
