import { describe, expect, it } from 'vitest'
import type { Paint } from '../../types'
import { fillColor, isPaint, paintColor, samePaint, solid } from './paint'

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
    ]) {
      expect(isPaint(value)).toBe(false)
    }
  })
})
