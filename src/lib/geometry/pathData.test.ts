import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SHAPE_STYLE,
  createEllipseNode,
  createLineNode,
  createRectNode,
} from '../../store/editorStore'
import type { Anchor } from '../../types'
import {
  KAPPA,
  anchorWithKind,
  cachedPathData,
  corner,
  insertAnchor,
  pathData,
  pathSegments,
  shapeAnchors,
  withHandle,
  withKind,
  type Cubic,
  type Xy,
} from './pathData'

const anchor = (
  x: number,
  y: number,
  [inX, inY]: Xy = [0, 0],
  [outX, outY]: Xy = [0, 0],
  kind: Anchor['kind'] = 'corner',
): Anchor => ({ x, y, inX, inY, outX, outY, kind })

/** A point on a cubic segment, by de Casteljau's formula. */
function pointAt([p0, p1, p2, p3]: Cubic, t: number): Xy {
  const u = 1 - t
  const at = (i: 0 | 1) =>
    u * u * u * p0[i] + 3 * u * u * t * p1[i] + 3 * u * t * t * p2[i] + t * t * t * p3[i]
  return [at(0), at(1)]
}

const close = ([x, y]: Xy, [ex, ey]: Xy, digits = 6) => {
  expect(x).toBeCloseTo(ex, digits)
  expect(y).toBeCloseTo(ey, digits)
}

// An arch: up from (0, 0) and down to (100, 0), its handles 100 units tall.
const arch = [anchor(0, 0, [0, 0], [0, -100]), anchor(100, 0, [0, -100], [0, 0])]

describe('pathData', () => {
  it('writes M at the first anchor and C prev.out, cur.in, cur for each segment', () => {
    expect(pathData(arch, false)).toBe('M 0 0 C 0 -100 100 -100 100 0')
    expect(
      pathData([anchor(10, 20), anchor(30, 20, [-5, 5], [5, 5]), anchor(50, 20, [0, 10])], false),
    ).toBe('M 10 20 C 10 20 25 25 30 20 C 35 25 50 30 50 20')
  })

  it('adds a segment back to the first anchor and Z when the path is closed', () => {
    const anchors = [anchor(0, 0, [-10, 0], [10, 0]), anchor(100, 0), anchor(50, 80, [5, 5])]

    expect(pathData(anchors, true)).toBe(
      'M 0 0 C 10 0 100 0 100 0 C 100 0 55 85 50 80 C 50 80 -10 0 0 0 Z',
    )
  })

  it('keeps a lone anchor and nothing at all as such', () => {
    expect(pathData([], false)).toBe('')
    expect(pathData([anchor(5, 6)], false)).toBe('M 5 6')
  })

  it('rounds to thousandths without writing -0', () => {
    expect(pathData([anchor(1 / 3, -0.0001), anchor(2.0004, -1e-9)], false)).toBe(
      'M 0.333 0 C 0.333 0 2 0 2 0',
    )
  })

  it('caches the data by the anchors array, and notices closing', () => {
    const anchors = [...arch]
    const first = cachedPathData({ anchors, closed: false })

    expect(cachedPathData({ anchors, closed: false })).toBe(first)
    expect(cachedPathData({ anchors, closed: true })).toBe(`${first} C 100 0 0 0 0 0 Z`)
  })
})

describe('pathSegments', () => {
  it('maps every control point, for example into canvas units', () => {
    const shifted = pathSegments(arch, false, (x, y) => [x + 1000, y * 2])

    expect(shifted).toEqual([
      [
        [1000, 0],
        [1000, -200],
        [1100, -200],
        [1100, 0],
      ],
    ])
    expect(pathSegments([anchor(0, 0)], true)).toEqual([])
  })
})

describe('withHandle', () => {
  const smooth = anchor(0, 0, [-10, 0], [20, 0], 'smooth')

  it('turns a smooth anchor’s other handle in line, keeping its length', () => {
    const moved = withHandle(smooth, 'out', [0, 40])

    expect(moved).toEqual({ ...smooth, outX: 0, outY: 40, inX: 0, inY: -10 })
  })

  it('mirrors a symmetric anchor’s other handle', () => {
    expect(withHandle({ ...smooth, kind: 'symmetric' }, 'in', [3, -4])).toMatchObject({
      inX: 3,
      inY: -4,
      outX: -3,
      outY: 4,
    })
  })

  it('leaves a corner’s other handle alone', () => {
    expect(withHandle({ ...smooth, kind: 'corner' }, 'out', [0, 40])).toMatchObject({
      inX: -10,
      inY: 0,
    })
  })

  it('breaks the link and makes a corner when asked (Alt)', () => {
    expect(withHandle(smooth, 'out', [0, 40], true)).toEqual({
      ...smooth,
      outX: 0,
      outY: 40,
      kind: 'corner',
    })
  })

  it('leaves the other handle alone when a smooth handle has no length', () => {
    expect(withHandle(smooth, 'out', [0, 0])).toMatchObject({ inX: -10, inY: 0 })
  })
})

describe('withKind and anchorWithKind', () => {
  const bent = anchor(0, 0, [0, 10], [20, 0])

  it('lines the in handle up with the out handle, mirrored when symmetric', () => {
    expect(withKind(bent, 'smooth')).toEqual({ ...bent, inX: -10, inY: 0, kind: 'smooth' })
    expect(withKind(bent, 'symmetric')).toEqual({ ...bent, inX: -20, inY: 0, kind: 'symmetric' })
    expect(withKind(bent, 'corner')).toEqual(bent)
  })

  it('pulls handles out of a bare anchor, parallel to its neighbors', () => {
    const anchors = [anchor(0, 0), anchor(60, 30), anchor(120, 0)]

    // A third of the way to each neighbor, which are equally far.
    const third = Math.hypot(60, 30) / 3
    expect(anchorWithKind(anchors, false, 1, 'smooth')).toEqual(
      anchor(60, 30, [-third, 0], [third, 0], 'smooth'),
    )
    // The ends of an open path have one neighbor: the handle toward it, and none away.
    expect(anchorWithKind(anchors, false, 0, 'smooth')).toMatchObject({ inX: 0, inY: 0 })
    // A closed path's first anchor has the last for a neighbor too.
    const first = anchorWithKind(anchors, true, 0, 'symmetric')
    expect(first.outX).toBeCloseTo(-first.inX, 9)
    expect(first.outY).toBeCloseTo(-first.inY, 9)
    expect(Math.hypot(first.outX, first.outY)).toBeGreaterThan(0)
  })

  it('keeps existing handles, and pulls none for a corner', () => {
    const anchors = [anchor(0, 0), bent, anchor(120, 0)]

    expect(anchorWithKind(anchors, false, 1, 'smooth')).toEqual(withKind(bent, 'smooth'))
    expect(anchorWithKind([anchor(0, 0), anchor(5, 5)], false, 1, 'corner')).toEqual(anchor(5, 5))
  })
})

describe('insertAnchor', () => {
  it('splits a curve where asked, keeping its shape', () => {
    const [before] = pathSegments(arch, false)
    const anchors = insertAnchor(arch, false, 0, 0.25)
    const [left, right] = pathSegments(anchors, false)

    expect(anchors).toHaveLength(3)
    expect(anchors[1].kind).toBe('smooth')
    close([anchors[1].x, anchors[1].y], pointAt(before, 0.25))
    for (const s of [0, 0.3, 0.7, 1]) {
      close(pointAt(left, s), pointAt(before, 0.25 * s))
      close(pointAt(right, s), pointAt(before, 0.25 + 0.75 * s))
    }
  })

  it('adds a corner on a straight segment, which stays straight', () => {
    const square = [anchor(0, 0), anchor(100, 0), anchor(100, 100), anchor(0, 100)]

    expect(insertAnchor(square, true, 3, 0.5)).toEqual([...square, anchor(0, 50)])
    expect(insertAnchor(square, false, 0, 0.25)[1]).toEqual(anchor(25, 0))
  })

  it('splits the closing segment, updating the first anchor’s in handle', () => {
    const loop = [anchor(0, 0, [0, 60]), anchor(100, 0, [0, 0], [0, 60])]
    const [, closing] = pathSegments(loop, true)
    const anchors = insertAnchor(loop, true, 1, 0.5)

    expect(anchors).toHaveLength(3)
    close([anchors[2].x, anchors[2].y], pointAt(closing, 0.5))
    // Halfway from the closing segment's last control point (0, 60) to the first anchor.
    close(pathSegments(anchors, true)[2][2], [0, 30])
  })
})

describe('shapeAnchors', () => {
  const box = { x: 10, y: 20, width: 100, height: 40 }

  it('turns a sharp rectangle into 4 corners and a line into 2', () => {
    expect(shapeAnchors(createRectNode(box, DEFAULT_SHAPE_STYLE))).toEqual({
      anchors: [anchor(0, 0), anchor(100, 0), anchor(100, 40), anchor(0, 40)],
      closed: true,
    })
    expect(shapeAnchors(createLineNode([10, 20], [60, 0], DEFAULT_SHAPE_STYLE))).toEqual({
      anchors: [corner(0, 0), corner(50, -20)],
      closed: false,
    })
  })

  it('rounds corners with quarter circles, merging anchors that meet', () => {
    const rect = createRectNode(box, DEFAULT_SHAPE_STYLE)
    const rounded = shapeAnchors({ ...rect, cornerRadius: 10 }).anchors
    expect(rounded).toHaveLength(8)
    expect(rounded[1]).toEqual(anchor(90, 0, [0, 0], [KAPPA * 10, 0], 'smooth'))
    expect(rounded[2]).toEqual(anchor(100, 10, [0, -KAPPA * 10], [0, 0], 'smooth'))

    // A radius of half the height leaves the short sides with one anchor each.
    expect(shapeAnchors({ ...rect, cornerRadius: 50 }).anchors).toHaveLength(6)
    const circle = shapeAnchors({ ...rect, height: 100, cornerRadius: 50 }).anchors
    expect(circle).toHaveLength(4)
    expect(circle[0]).toEqual(anchor(50, 0, [-KAPPA * 50, 0], [KAPPA * 50, 0], 'smooth'))
  })

  it('turns an ellipse into 4 symmetric anchors with handles 0.5523 × the radius', () => {
    const ellipse = createEllipseNode({ x: 0, y: 0, width: 200, height: 100 }, DEFAULT_SHAPE_STYLE)
    const { anchors, closed } = shapeAnchors(ellipse)

    expect(closed).toBe(true)
    expect(anchors).toEqual([
      anchor(100, 0, [0, -KAPPA * 50], [0, KAPPA * 50], 'symmetric'),
      anchor(0, 50, [KAPPA * 100, 0], [-KAPPA * 100, 0], 'symmetric'),
      anchor(-100, 0, [0, KAPPA * 50], [0, -KAPPA * 50], 'symmetric'),
      anchor(0, -50, [-KAPPA * 100, 0], [KAPPA * 100, 0], 'symmetric'),
    ])
    // Halfway along a quarter, the curve is within 0.1% of the ellipse.
    const [x, y] = pointAt(pathSegments(anchors, true)[0], 0.5)
    expect(Math.abs((x / 100) ** 2 + (y / 50) ** 2 - 1)).toBeLessThan(0.002)
  })
})
