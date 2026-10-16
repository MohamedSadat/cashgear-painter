import { describe, expect, it } from 'vitest'
import type { Point } from '../../types'
import { eraseSplit } from './eraseSplit'

/** A horizontal brush stroke along y = 0 with a point every 10 units, pressure rising along it. */
function line(fromX: number, toX: number): Point[] {
  const points: Point[] = []
  for (let x = fromX; x <= toX; x += 10)
    points.push([x, 0, 0.2 + (0.6 * (x - fromX)) / (toX - fromX)])
  return points
}

/** A vertical eraser stroke at x. */
const eraserAt = (x: number, size = 20) => ({
  points: [
    [x, -50, 0.5],
    [x, 50, 0.5],
  ] as Point[],
  size,
})

const xs = (run: Point[]) => run.map(([x]) => x)

describe('eraseSplit', () => {
  it('returns the same points when the eraser misses', () => {
    const points = line(0, 100)

    const runs = eraseSplit(points, 8, eraserAt(300))

    expect(runs).toHaveLength(1)
    expect(runs[0]).toBe(points)
  })

  it('returns the same points when the eraser only passes near', () => {
    const points = line(0, 100)
    // Reach is 10 + 4 = 14; the eraser line runs 20 below the stroke.
    const eraser = {
      points: [
        [-50, 20, 0.5],
        [150, 20, 0.5],
      ] as Point[],
      size: 20,
    }

    expect(eraseSplit(points, 8, eraser)[0]).toBe(points)
  })

  it('cuts a crossing into two runs that end at the eraser reach', () => {
    const points = line(0, 100)

    const [left, right] = eraseSplit(points, 8, eraserAt(50))

    // Reach is eraser radius 10 + brush radius 4.
    expect(xs(left).slice(0, -1)).toEqual([0, 10, 20, 30])
    expect(left.at(-1)![0]).toBeCloseTo(36, 1)
    expect(right[0][0]).toBeCloseTo(64, 1)
    expect(xs(right).slice(1)).toEqual([70, 80, 90, 100])
  })

  it('keeps original points as the same objects', () => {
    const points = line(0, 100)

    const [left, right] = eraseSplit(points, 8, eraserAt(50))

    expect(left[0]).toBe(points[0])
    expect(right.at(-1)).toBe(points.at(-1))
  })

  it('interpolates pressure at the cut', () => {
    const points = line(0, 100)

    const [left] = eraseSplit(points, 8, eraserAt(50))
    const [x, , pressure] = left.at(-1)!

    expect(pressure).toBeCloseTo(0.2 + (0.6 * x) / 100, 5)
  })

  it('splits once per crossing', () => {
    const points = line(0, 200)
    const eraser = {
      points: [
        [50, -50, 0.5],
        [50, 50, 0.5],
        [150, 50, 0.5],
        [150, -50, 0.5],
      ] as Point[],
      size: 20,
    }

    expect(eraseSplit(points, 8, eraser)).toHaveLength(3)
  })

  it('cuts between widely spaced points', () => {
    const points: Point[] = [
      [0, 0, 0.5],
      [200, 0, 0.5],
    ]

    const runs = eraseSplit(points, 8, eraserAt(100, 10))

    expect(runs).toHaveLength(2)
    expect(runs[0].at(-1)![0]).toBeCloseTo(91, 1)
    expect(runs[1][0][0]).toBeCloseTo(109, 1)
  })

  it('removes a stroke the eraser covers completely', () => {
    const points = line(0, 40)
    const eraser = {
      points: [
        [0, 0, 0.5],
        [40, 0, 0.5],
      ] as Point[],
      size: 30,
    }

    expect(eraseSplit(points, 8, eraser)).toEqual([])
  })

  it('keeps the end that pokes out past the eraser, from the cut to the last point', () => {
    const points: Point[] = [
      [0, 0, 0.5],
      [100, 0, 0.5],
    ]
    // Reach is 20 + 4, so everything up to x = 94 is erased.
    const eraser = {
      points: [
        [-20, 0, 0.5],
        [70, 0, 0.5],
      ] as Point[],
      size: 40,
    }

    const runs = eraseSplit(points, 8, eraser)

    expect(runs).toHaveLength(1)
    expect(runs[0]).toHaveLength(2)
    expect(runs[0][0][0]).toBeCloseTo(94, 1)
  })

  it('erases with a single-point eraser (a click)', () => {
    const points = line(0, 100)
    const eraser = { points: [[50, 0, 0.5]] as Point[], size: 20 }

    expect(eraseSplit(points, 8, eraser)).toHaveLength(2)
  })

  it('erases a dot under the eraser and keeps one elsewhere', () => {
    const dot: Point[] = [[50, 0, 0.5]]

    expect(eraseSplit(dot, 8, eraserAt(50))).toEqual([])
    expect(eraseSplit(dot, 8, eraserAt(200))[0]).toBe(dot)
  })
})
