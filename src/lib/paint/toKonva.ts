import { fillBox } from '../geometry/bounds'
import type { Page, Paint, VectorNode } from '../../types'
import { lastStop, placeGradient, stopCss, type PaintBox, type Xy } from './paint'

type Vector2d = { x: number; y: number }

/**
 * A fill as Konva's attributes. Every attribute is always given, unused ones as undefined, so a
 * fill that changes kind never leaves an old gradient behind: react-konva only sets what it is
 * given. `fillPriority` picks which of them Konva paints.
 */
export interface KonvaFill {
  fill: string | undefined
  fillPriority: 'color' | 'linear-gradient' | 'radial-gradient'
  fillLinearGradientStartPoint: Vector2d | undefined
  fillLinearGradientEndPoint: Vector2d | undefined
  fillLinearGradientColorStops: (number | string)[] | undefined
  fillRadialGradientStartPoint: Vector2d | undefined
  fillRadialGradientEndPoint: Vector2d | undefined
  fillRadialGradientStartRadius: number | undefined
  fillRadialGradientEndRadius: number | undefined
  fillRadialGradientColorStops: (number | string)[] | undefined
}

const NO_GRADIENT = {
  fillLinearGradientStartPoint: undefined,
  fillLinearGradientEndPoint: undefined,
  fillLinearGradientColorStops: undefined,
  fillRadialGradientStartPoint: undefined,
  fillRadialGradientEndPoint: undefined,
  fillRadialGradientStartRadius: undefined,
  fillRadialGradientEndRadius: undefined,
  fillRadialGradientColorStops: undefined,
} as const

const colorFill = (fill: string | undefined): KonvaFill => ({
  ...NO_GRADIENT,
  fill,
  fillPriority: 'color',
})

const point = ([x, y]: Xy): Vector2d => ({ x, y })

/**
 * A fill as Konva paints it in a shape's own coordinates. Gradient points, stored in units of the
 * node's fill box (0..1), become local pixels: `box` gives that box, and is only asked for a
 * gradient. Konva's color stops are a flat [offset, color, …] list in offset order, with each
 * stop's opacity in its color as rgba(). A radial gradient grows from its center: both of
 * Konva's points there, from radius 0. A gradient without extent, or without a box, is painted
 * with one color: its last stop, as SVG paints it, or its first without a box.
 */
export function toKonvaFill(fill: Paint | null, box: () => PaintBox | null): KonvaFill {
  if (fill === null) return colorFill(undefined)
  if (fill.kind === 'solid') return colorFill(fill.color)
  const area = box()
  if (!area) return colorFill(stopCss(fill.stops[0]))
  const placed = placeGradient(fill, area)
  if (!placed) return colorFill(stopCss(lastStop(fill)))
  const stops = placed.stops.flatMap((stop) => [stop.offset, stopCss(stop)])
  if (placed.kind === 'linear') {
    return {
      ...NO_GRADIENT,
      fill: undefined,
      fillPriority: 'linear-gradient',
      fillLinearGradientStartPoint: point(placed.start),
      fillLinearGradientEndPoint: point(placed.end),
      fillLinearGradientColorStops: stops,
    }
  }
  const center = point(placed.center)
  return {
    ...NO_GRADIENT,
    fill: undefined,
    fillPriority: 'radial-gradient',
    fillRadialGradientStartPoint: center,
    fillRadialGradientEndPoint: center,
    fillRadialGradientStartRadius: 0,
    fillRadialGradientEndRadius: placed.radius,
    fillRadialGradientColorStops: stops,
  }
}

// Keyed by the node or page object, which immer replaces whenever it changes: a node redrawn for
// another reason, such as a zoom, hands Konva the same objects and keeps its cached gradient.
const fillCache = new WeakMap<VectorNode | Page, KonvaFill>()

/** A node's fill as Konva attributes, laid out in its fill box (fillBox). */
export function nodeKonvaFill(node: VectorNode): KonvaFill {
  let fill = fillCache.get(node)
  if (!fill) {
    fill = toKonvaFill(node.style.fill, () => fillBox(node))
    fillCache.set(node, fill)
  }
  return fill
}

/** The box a page's background is laid out in: the page itself. */
export const pageBox = (page: Pick<Page, 'width' | 'height'>): PaintBox => ({
  minX: 0,
  minY: 0,
  maxX: page.width,
  maxY: page.height,
})

/** A page's background as Konva attributes for the page's rectangle. */
export function pageKonvaFill(page: Page): KonvaFill {
  let fill = fillCache.get(page)
  if (!fill) {
    fill = toKonvaFill(page.background, () => pageBox(page))
    fillCache.set(page, fill)
  }
  return fill
}
