import { describe, expect, it } from 'vitest'
import type { Point } from '../types'
import { getSvgPathFromStroke, strokeToPath } from './strokePath'

const line = (pressure: number): Point[] =>
  Array.from({ length: 20 }, (_, i): Point => [i * 10, i * 5, pressure])

describe('strokeToPath', () => {
  it('returns an empty path for a stroke with no points', () => {
    expect(strokeToPath({ points: [], size: 8, usesPressure: false })).toBe('')
  })

  it('draws a closed dot for a single tap', () => {
    const path = strokeToPath({ points: [[50, 50, 0.5]], size: 8, usesPressure: false })

    expect(path).toMatch(/^M[\d.-]+,[\d.-]+ Q/)
    expect(path.endsWith('Z')).toBe(true)
  })

  it('draws a closed outline for a line', () => {
    const path = strokeToPath({ points: line(0.5), size: 8, usesPressure: false })

    expect(path.startsWith('M')).toBe(true)
    expect(path.endsWith('Z')).toBe(true)
  })

  it('follows pen pressure when the stroke uses it', () => {
    const light = strokeToPath({ points: line(0.1), size: 16, usesPressure: true })
    const heavy = strokeToPath({ points: line(0.9), size: 16, usesPressure: true })

    expect(light).not.toBe(heavy)
  })
})

describe('getSvgPathFromStroke', () => {
  it('needs at least four outline points', () => {
    expect(
      getSvgPathFromStroke([
        [0, 0],
        [1, 1],
        [2, 2],
      ]),
    ).toBe('')
  })

  it('builds a quadratic path through the outline midpoints', () => {
    const path = getSvgPathFromStroke([
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
    ])

    expect(path).toBe('M0.00,0.00 Q10.00,0.00 10.00,5.00 T5.00,10.00 Z')
  })
})
