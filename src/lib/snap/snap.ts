import type { Box } from '../geometry/bounds'

/** Screen pixels within which a moving edge or center snaps to a target line. */
export const SNAP_PX = 6
/** Canvas units between the optional grid's lines. */
export const GRID_SIZE = 8
// Target lines this close to a snapped value share its guide: aligned, give or take float noise.
const SAME_LINE = 0.01

/** A box as the lines it snaps by. */
export interface SnapBox {
  left: number
  centerX: number
  right: number
  top: number
  centerY: number
  bottom: number
}

/**
 * A target line: at `at` on its axis (x for a vertical line), drawn from `from` to `to` along the
 * other axis, where the object it belongs to spans.
 */
export interface SnapLine {
  at: number
  from: number
  to: number
}

export interface SnapTargets {
  x: SnapLine[] // vertical lines, sorted by `at`
  y: SnapLine[] // horizontal lines, sorted by `at`
  grid: number | null // grid spacing, or null without a grid
}

/** A smart guide: a line at `at` on `axis`, from `from` to `to` along the other axis. */
export interface Guide {
  axis: 'x' | 'y'
  at: number
  from: number
  to: number
}

export interface SnapResult {
  dx: number
  dy: number // correction to apply to the moving box
  guides: Guide[]
}

export type Edge = 'left' | 'right' | 'top' | 'bottom'

export function toSnapBox({ minX, minY, maxX, maxY }: Box): SnapBox {
  return {
    left: minX,
    centerX: (minX + maxX) / 2,
    right: maxX,
    top: minY,
    centerY: (minY + maxY) / 2,
    bottom: maxY,
  }
}

/** The box moved by dx and dy. */
export function shiftBox(box: Box, dx: number, dy: number): Box {
  return { minX: box.minX + dx, minY: box.minY + dy, maxX: box.maxX + dx, maxY: box.maxY + dy }
}

/** A point as a box with no size, so a point snaps as a box does. */
export const pointBox = (x: number, y: number): Box => ({ minX: x, minY: y, maxX: x, maxY: y })

/** The screen's 6 px in canvas units at the zoom; 0, for no snapping, before the canvas is measured. */
export function snapThreshold(zoom: number): number {
  return zoom > 0 ? SNAP_PX / zoom : 0
}

/** Lines sorted by where they are, as SnapTargets holds them. */
export function sortLines(lines: SnapLine[]): SnapLine[] {
  return lines.sort((a, b) => a.at - b.at)
}

/** Index of the first line at or past `value`. */
function lowerBound(lines: readonly SnapLine[], value: number): number {
  let lo = 0
  let hi = lines.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (lines[mid].at < value) lo = mid + 1
    else hi = mid
  }
  return lo
}

/** The line nearest to `value`; undefined when there are none. */
function nearestLine(lines: readonly SnapLine[], value: number): SnapLine | undefined {
  const i = lowerBound(lines, value)
  const after = lines[i]
  const before = lines[i - 1]
  if (!before) return after
  if (!after) return before
  return value - before.at <= after.at - value ? before : after
}

/**
 * The smallest correction within `threshold` that puts one of `values` on a target line, or one
 * of `gridValues` on a grid line; null when none is that close. A line wins a tie with the grid,
 * so its guide shows.
 */
function bestDelta(
  values: readonly number[],
  gridValues: readonly number[],
  lines: readonly SnapLine[],
  grid: number | null,
  threshold: number,
): number | null {
  let best: number | null = null
  const consider = (delta: number) => {
    if (Math.abs(delta) <= threshold && (best === null || Math.abs(delta) < Math.abs(best))) {
      best = delta
    }
  }
  for (const value of values) {
    const line = nearestLine(lines, value)
    if (line) consider(line.at - value)
  }
  if (grid !== null && grid > 0) {
    for (const value of gridValues) consider(Math.round(value / grid) * grid - value)
  }
  return best
}

/**
 * The guides for `values` on one axis: one per value that lies on target lines, spanning from the
 * moving box (`from` to `to` along the other axis) to the farthest object sharing that line.
 */
function guidesOn(
  axis: 'x' | 'y',
  values: readonly number[],
  lines: readonly SnapLine[],
  from: number,
  to: number,
): Guide[] {
  const guides: Guide[] = []
  for (const value of values) {
    if (guides.some((g) => Math.abs(g.at - value) <= SAME_LINE)) continue
    let start = from
    let end = to
    let nearest: number | null = null
    for (let i = lowerBound(lines, value - SAME_LINE); i < lines.length; i++) {
      const line = lines[i]
      if (line.at > value + SAME_LINE) break
      if (nearest === null || Math.abs(line.at - value) < Math.abs(nearest - value)) {
        nearest = line.at
      }
      start = Math.min(start, line.from)
      end = Math.max(end, line.to)
    }
    if (nearest !== null) guides.push({ axis, at: nearest, from: start, to: end })
  }
  return guides
}

const xValues = (box: SnapBox) => [box.left, box.centerX, box.right]
const yValues = (box: SnapBox) => [box.top, box.centerY, box.bottom]

/**
 * Snaps a moving box: on each axis on its own, the left, center or right (top, middle or bottom)
 * nearest to a target line within `threshold` lands on it, or else an edge nearest to a grid line.
 * Returns the correction and the guides of the lines the moved box then lies on.
 */
export function snapMove(moving: SnapBox, targets: SnapTargets, threshold: number): SnapResult {
  const { grid } = targets
  const dx =
    bestDelta(xValues(moving), [moving.left, moving.right], targets.x, grid, threshold) ?? 0
  const dy =
    bestDelta(yValues(moving), [moving.top, moving.bottom], targets.y, grid, threshold) ?? 0
  const guides = [
    ...guidesOn(
      'x',
      xValues(moving).map((v) => v + dx),
      targets.x,
      moving.top + dy,
      moving.bottom + dy,
    ),
    ...guidesOn(
      'y',
      yValues(moving).map((v) => v + dy),
      targets.y,
      moving.left + dx,
      moving.right + dx,
    ),
  ]
  return { dx, dy, guides }
}

function edgeValues(box: SnapBox, edges: readonly Edge[], axis: 'x' | 'y'): number[] {
  return edges.flatMap((edge) => {
    if (axis === 'x') return edge === 'left' ? [box.left] : edge === 'right' ? [box.right] : []
    return edge === 'top' ? [box.top] : edge === 'bottom' ? [box.bottom] : []
  })
}

/**
 * Snaps the edges a resize moves: `dx` is the correction for the moving left or right edge, `dy`
 * for the top or bottom one. Centers don't snap, since they move only half as far.
 */
export function snapResize(
  moving: SnapBox,
  edges: readonly Edge[],
  targets: SnapTargets,
  threshold: number,
): SnapResult {
  const xs = edgeValues(moving, edges, 'x')
  const ys = edgeValues(moving, edges, 'y')
  const dx = bestDelta(xs, xs, targets.x, targets.grid, threshold) ?? 0
  const dy = bestDelta(ys, ys, targets.y, targets.grid, threshold) ?? 0
  return { dx, dy, guides: resizeGuides(shiftEdges(moving, edges, dx, dy), edges, targets) }
}

function shiftEdges(box: SnapBox, edges: readonly Edge[], dx: number, dy: number): SnapBox {
  const has = (edge: Edge) => edges.includes(edge)
  const minX = box.left + (has('left') ? dx : 0)
  const maxX = box.right + (has('right') ? dx : 0)
  const minY = box.top + (has('top') ? dy : 0)
  const maxY = box.bottom + (has('bottom') ? dy : 0)
  return toSnapBox({ minX, minY, maxX, maxY })
}

function resizeGuides(box: SnapBox, edges: readonly Edge[], targets: SnapTargets): Guide[] {
  return [
    ...guidesOn('x', edgeValues(box, edges, 'x'), targets.x, box.top, box.bottom),
    ...guidesOn('y', edgeValues(box, edges, 'y'), targets.y, box.left, box.right),
  ]
}

export interface ResizeOptions {
  keepRatio?: boolean // a corner drag that keeps the box's ratio
  centered?: boolean // the opposite edges move the other way, about the center
}

/**
 * A box being resized by dragging `edges`, snapped: the result box and its guides. Centered, the
 * opposite edge mirrors each correction. Keeping the ratio, only the axis with the smaller
 * correction snaps, and the other side follows the ratio from the fixed corner (or the center).
 */
export function snapResizeBox(
  box: Box,
  edges: readonly Edge[],
  targets: SnapTargets,
  threshold: number,
  { keepRatio = false, centered = false }: ResizeOptions = {},
): { box: Box; guides: Guide[] } {
  const xs = edgeValues(toSnapBox(box), edges, 'x')
  const ys = edgeValues(toSnapBox(box), edges, 'y')
  let dx = bestDelta(xs, xs, targets.x, targets.grid, threshold)
  let dy = bestDelta(ys, ys, targets.y, targets.grid, threshold)
  const corner = xs.length > 0 && ys.length > 0
  const ratioKept = keepRatio && corner && box.maxY > box.minY
  if (ratioKept && dx !== null && dy !== null) {
    if (Math.abs(dx) <= Math.abs(dy)) dy = null
    else dx = null
  }

  let { minX, minY, maxX, maxY } = box
  if (dx !== null) {
    if (edges.includes('left')) {
      minX += dx
      if (centered) maxX -= dx
    } else {
      maxX += dx
      if (centered) minX -= dx
    }
  }
  if (dy !== null) {
    if (edges.includes('top')) {
      minY += dy
      if (centered) maxY -= dy
    } else {
      maxY += dy
      if (centered) minY -= dy
    }
  }
  if (ratioKept && (dx !== null || dy !== null)) {
    const ratio = (box.maxX - box.minX) / (box.maxY - box.minY)
    if (dx !== null) {
      // The width snapped; the height follows it.
      const height = (maxX - minX) / ratio
      if (centered) {
        const middle = (box.minY + box.maxY) / 2
        minY = middle - height / 2
        maxY = middle + height / 2
      } else if (edges.includes('top')) minY = maxY - height
      else maxY = minY + height
    } else {
      const width = (maxY - minY) * ratio
      if (centered) {
        const middle = (box.minX + box.maxX) / 2
        minX = middle - width / 2
        maxX = middle + width / 2
      } else if (edges.includes('left')) minX = maxX - width
      else maxX = minX + width
    }
  }

  const result = { minX, minY, maxX, maxY }
  const snapped = toSnapBox(result)
  const guides = [
    ...(dx === null ? [] : guidesOn('x', edgeValues(snapped, edges, 'x'), targets.x, minY, maxY)),
    ...(dy === null ? [] : guidesOn('y', edgeValues(snapped, edges, 'y'), targets.y, minX, maxX)),
  ]
  return { box: result, guides }
}

/** Whether two guide lists draw the same lines, so the overlay needn't redraw. */
export function sameGuides(a: readonly Guide[], b: readonly Guide[]): boolean {
  return (
    a.length === b.length &&
    a.every(
      (g, i) =>
        g.axis === b[i].axis && g.at === b[i].at && g.from === b[i].from && g.to === b[i].to,
    )
  )
}
