import { describe, expect, it } from 'vitest'
import type { Box } from '../geometry/bounds'
import {
  GRID_SIZE,
  SNAP_PX,
  pointBox,
  sameGuides,
  shiftBox,
  snapMove,
  snapResize,
  snapResizeBox,
  snapThreshold,
  sortLines,
  toSnapBox,
  type SnapLine,
  type SnapTargets,
} from './snap'

const PAGE = { width: 1600, height: 1000 }

/** The lines of each box, as collectTargets makes them. */
function targetsOf(boxes: Box[], grid: number | null = null): SnapTargets {
  const x: SnapLine[] = []
  const y: SnapLine[] = []
  for (const { minX, minY, maxX, maxY } of boxes) {
    for (const at of [minX, (minX + maxX) / 2, maxX]) x.push({ at, from: minY, to: maxY })
    for (const at of [minY, (minY + maxY) / 2, maxY]) y.push({ at, from: minX, to: maxX })
  }
  return { x: sortLines(x), y: sortLines(y), grid }
}

const page: Box = { minX: 0, minY: 0, maxX: PAGE.width, maxY: PAGE.height }
const other: Box = { minX: 300, minY: 100, maxX: 400, maxY: 200 }
const targets = targetsOf([page, other])

/** A box with its left at x and its top at y, 100 × 50 unless sized, as SnapBox. */
const boxAt = (x: number, y: number, width = 100, height = 50) =>
  toSnapBox({ minX: x, minY: y, maxX: x + width, maxY: y + height })

describe('snapThreshold', () => {
  it('is 6 screen pixels in canvas units, and nothing before the canvas is measured', () => {
    expect(snapThreshold(1)).toBe(SNAP_PX)
    expect(snapThreshold(0.25)).toBe(24)
    expect(snapThreshold(4)).toBe(1.5)
    expect(snapThreshold(0)).toBe(0)
  })
})

describe.each([0.25, 1, 4])('snapMove at %s× zoom', (zoom) => {
  const threshold = snapThreshold(zoom)
  // Canvas units for a distance in screen pixels.
  const px = (n: number) => n / zoom

  it('snaps to the page edges within 6 screen px, and not past them', () => {
    expect(snapMove(boxAt(px(5), 300), targets, threshold)).toMatchObject({ dx: -px(5), dy: 0 })
    expect(snapMove(boxAt(px(-6), 300), targets, threshold).dx).toBeCloseTo(px(6))
    expect(snapMove(boxAt(px(7), 300), targets, threshold)).toEqual({ dx: 0, dy: 0, guides: [] })

    // The right edge to the page's right, the bottom to its bottom.
    const corner = snapMove(boxAt(1500 - px(4), 950 + px(3)), targets, threshold)
    expect(corner.dx).toBeCloseTo(px(4))
    expect(corner.dy).toBeCloseTo(-px(3))
    expect(corner.guides).toEqual([
      { axis: 'x', at: 1600, from: 0, to: 1000 },
      { axis: 'y', at: 1000, from: 0, to: 1600 },
    ])
  })

  it('snaps to the page center within 6 screen px', () => {
    // A wide box, so only its center is near the page's: at 800 + 5 px.
    const result = snapMove(boxAt(600 + px(5), 300, 400), targets, threshold)
    expect(result.dx).toBeCloseTo(-px(5))
    expect(result.guides).toEqual([{ axis: 'x', at: 800, from: 0, to: 1000 }])
    expect(snapMove(boxAt(600 + px(7), 300, 400), targets, threshold).dx).toBe(0)

    const middle = snapMove(boxAt(1200, 300 - px(6), 100, 400), targets, threshold)
    expect(middle.dy).toBeCloseTo(px(6))
    expect(middle.guides).toEqual([{ axis: 'y', at: 500, from: 0, to: 1600 }])
  })

  it('snaps to other objects within 6 screen px, with a guide from one to the other', () => {
    // Left edge to the other's right edge, below it.
    const result = snapMove(boxAt(400 + px(5), 600), targets, threshold)
    expect(result.dx).toBeCloseTo(-px(5))
    expect(result.guides).toEqual([{ axis: 'x', at: 400, from: 100, to: 650 }])
    expect(snapMove(boxAt(400 + px(7), 600), targets, threshold).guides).toEqual([])

    // Top to the other's middle, beside it.
    const beside = snapMove(boxAt(1000, 150 - px(2), 100, 200), targets, threshold)
    expect(beside.dy).toBeCloseTo(px(2))
    expect(beside.guides).toEqual([{ axis: 'y', at: 150, from: 300, to: 1100 }])
  })
})

describe('snapMove', () => {
  it('snaps each axis on its own, to the nearest line', () => {
    const result = snapMove(boxAt(403, 196), targets, 6)
    expect(result.dx).toBe(-3) // left to the other's right
    expect(result.dy).toBe(4) // top to the other's bottom
  })

  it('draws one guide per line, spanning every object on it', () => {
    const above: Box = { minX: 300, minY: 0, maxX: 360, maxY: 40 }
    const below: Box = { minX: 300, minY: 900, maxX: 380, maxY: 950 }
    const result = snapMove(boxAt(302, 400), targetsOf([above, below]), 6)
    expect(result.dx).toBe(-2)
    expect(result.guides).toEqual([{ axis: 'x', at: 300, from: 0, to: 950 }])
  })

  it('shows a guide for every line the snapped box lies on', () => {
    // The same size as `other`, so all three of its x lines meet other's.
    const result = snapMove(toSnapBox({ minX: 302, minY: 600, maxX: 402, maxY: 650 }), targets, 6)
    expect(result.guides.map((g) => g.at)).toEqual([300, 350, 400])
  })

  it('snaps edges to the grid, without guides; a line wins a tie with the grid', () => {
    const grid = targetsOf([], GRID_SIZE)
    expect(snapMove(boxAt(13, 21, 96, 48), grid, 6)).toEqual({ dx: 3, dy: 3, guides: [] })
    // Centers don't go to the grid: this one is 1 from a grid line, its edges 3.
    expect(snapMove(boxAt(13, 21, 104, 48), grid, 6).dx).toBe(3)
    // The left edge is 4 from the other's right edge, and 4 from the grid line at 408.
    const both = targetsOf([other], GRID_SIZE)
    expect(snapMove(boxAt(404, 597, 96, 48), both, 6)).toEqual({
      dx: -4,
      dy: 3,
      guides: [{ axis: 'x', at: 400, from: 100, to: 648 }],
    })
  })

  it('snaps a point, as a box of no size', () => {
    const result = snapMove(toSnapBox(pointBox(398, 105)), targets, 6)
    expect(result).toMatchObject({ dx: 2, dy: -5 })
    expect(result.guides).toEqual([
      { axis: 'x', at: 400, from: 100, to: 200 },
      { axis: 'y', at: 100, from: 300, to: 400 },
    ])
  })

  it('leaves a box alone when nothing is in reach', () => {
    expect(snapMove(boxAt(600, 600), targets, 6)).toEqual({ dx: 0, dy: 0, guides: [] })
    expect(snapMove(boxAt(1, 1), targets, 0)).toEqual({ dx: 0, dy: 0, guides: [] })
  })
})

describe('snapResize', () => {
  it('snaps only the edges that move', () => {
    // The right edge, 4 from the other's left.
    const box = toSnapBox({ minX: 196, minY: 600, maxX: 296, maxY: 700 })
    const result = snapResize(box, ['right'], targets, 6)
    expect(result).toMatchObject({ dx: 4, dy: 0 })
    expect(result.guides).toEqual([{ axis: 'x', at: 300, from: 100, to: 700 }])
    // The left edge has nothing in reach.
    expect(snapResize(box, ['left'], targets, 6)).toEqual({ dx: 0, dy: 0, guides: [] })
    // A center 2 from the page's doesn't snap: it moves only half as far as the edge.
    const centered = toSnapBox({ minX: 700, minY: 600, maxX: 896, maxY: 700 })
    expect(snapResize(centered, ['right'], targets, 6)).toEqual({ dx: 0, dy: 0, guides: [] })
  })

  it.each([0.25, 1, 4])('snaps a corner to the page within 6 screen px at %s× zoom', (zoom) => {
    const threshold = snapThreshold(zoom)
    const d = 5 / zoom
    const box = toSnapBox({ minX: 1000, minY: 600, maxX: 1600 - d, maxY: 1000 + d })
    const result = snapResize(box, ['right', 'bottom'], targets, threshold)
    expect(result.dx).toBeCloseTo(d)
    expect(result.dy).toBeCloseTo(-d)
  })
})

describe('snapResizeBox', () => {
  const box: Box = { minX: 1000, minY: 600, maxX: 1196, maxY: 698 }

  it('moves the snapped edges, and mirrors them when centered', () => {
    const right = targetsOf([page, { minX: 1200, minY: 100, maxX: 1300, maxY: 200 }])
    expect(snapResizeBox(box, ['right'], right, 6).box).toEqual({ ...box, maxX: 1200 })
    expect(snapResizeBox(box, ['right'], right, 6, { centered: true }).box).toEqual({
      ...box,
      minX: 996,
      maxX: 1200,
    })
  })

  it('keeps the ratio by snapping the nearer axis and scaling the other', () => {
    // Right edge 4 from x = 1200, bottom 3 from y = 701: the bottom snaps, and the width follows.
    const near = targetsOf([page, { minX: 1200, minY: 701, maxX: 1300, maxY: 800 }])
    const result = snapResizeBox(box, ['right', 'bottom'], near, 6, { keepRatio: true })
    expect(result.box.minX).toBe(1000)
    expect(result.box.minY).toBe(600)
    expect(result.box.maxY).toBe(701)
    expect((result.box.maxX - 1000) / (701 - 600)).toBeCloseTo(196 / 98)
    expect(result.guides.map((g) => g.axis)).toEqual(['y'])

    // From the top-left corner, the bottom-right stays put.
    const topLeft = snapResizeBox(box, ['left', 'top'], targetsOf([{ ...other, maxX: 1003 }]), 6, {
      keepRatio: true,
    })
    expect(topLeft.box.minX).toBe(1003)
    expect(topLeft.box.maxX).toBe(1196)
    expect(topLeft.box.maxY).toBe(698)
    expect((1196 - 1003) / (698 - topLeft.box.minY)).toBeCloseTo(2)
  })

  it('leaves the box alone with nothing in reach', () => {
    expect(snapResizeBox(box, ['left', 'top'], targets, 6, { keepRatio: true })).toEqual({
      box,
      guides: [],
    })
  })
})

describe('helpers', () => {
  it('shifts boxes and compares guides', () => {
    expect(shiftBox({ minX: 0, minY: 0, maxX: 10, maxY: 10 }, 5, -5)).toEqual({
      minX: 5,
      minY: -5,
      maxX: 15,
      maxY: 5,
    })
    const guide = { axis: 'x' as const, at: 1, from: 0, to: 2 }
    expect(sameGuides([guide], [{ ...guide }])).toBe(true)
    expect(sameGuides([guide], [{ ...guide, to: 3 }])).toBe(false)
    expect(sameGuides([], [guide])).toBe(false)
  })
})
