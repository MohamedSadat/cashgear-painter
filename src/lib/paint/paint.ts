import type { Paint, Stop } from '../../types'

export type Xy = [number, number]
export type Gradient = Extract<Paint, { kind: 'linear' | 'radial' }>
export type PaintKind = Paint['kind']

/** A box in a node's own coordinates: gradient points are stored in units of it, 0..1. */
export interface PaintBox {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

export function solid(color: string): Paint {
  return { kind: 'solid', color }
}

export const isGradient = (paint: Paint | null): paint is Gradient =>
  paint !== null && paint.kind !== 'solid'

/**
 * The one color that stands for a paint where only one fits, such as in the text editor: a
 * solid's own, or a gradient's first stop along it.
 */
export function paintColor(paint: Paint): string {
  return paint.kind === 'solid' ? paint.color : (sortedStops(paint.stops)[0]?.color ?? '#000000')
}

/** A fill as one CSS color: undefined for no fill. */
export function fillColor(fill: Paint | null): string | undefined {
  return fill === null ? undefined : paintColor(fill)
}

const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i

/** Whether a value is a #rgb or #rrggbb color, the only colors a gradient's stops take. */
export const isHexColor = (value: unknown): value is string =>
  typeof value === 'string' && HEX_COLOR.test(value)

/** A hex color's red, green and blue, 0..255; null for anything else. */
export function hexChannels(color: string): [number, number, number] | null {
  if (!isHexColor(color)) return null
  let digits = color.slice(1)
  if (digits.length === 3) digits = [...digits].map((d) => d + d).join('')
  return [0, 2, 4].map((i) => parseInt(digits.slice(i, i + 2), 16)) as [number, number, number]
}

const hex2 = (n: number) =>
  Math.round(Math.min(255, Math.max(0, n)))
    .toString(16)
    .padStart(2, '0')

/** Red, green and blue (0..255) as a #rrggbb color. */
export const channelsHex = ([r, g, b]: readonly number[]) => `#${hex2(r)}${hex2(g)}${hex2(b)}`

const clamp01 = (n: number) => Math.min(1, Math.max(0, n))

/** A stop's color as canvas and CSS take it: the hex color when opaque, else rgba(). */
export function stopCss({ color, opacity }: Stop): string {
  const alpha = clamp01(opacity)
  const rgb = hexChannels(color)
  if (alpha >= 1 || !rgb) return color
  return `rgba(${rgb.join(', ')}, ${Math.round(alpha * 1000) / 1000})`
}

/**
 * The stops in offset order, offsets and opacities kept within 0..1, as canvas and SVG both need
 * them; stops at the same offset keep their order, which makes a hard edge.
 */
export function sortedStops(stops: readonly Stop[]): Stop[] {
  return stops
    .map((stop) => ({ ...stop, offset: clamp01(stop.offset), opacity: clamp01(stop.opacity) }))
    .sort((a, b) => a.offset - b.offset)
}

/** The color and opacity a gradient has at offset t, mixed between its stops. */
export function stopAt(stops: readonly Stop[], t: number): Stop {
  const sorted = sortedStops(stops)
  const offset = clamp01(t)
  const after = sorted.findIndex((stop) => stop.offset > offset)
  if (after === 0) return { ...sorted[0], offset }
  if (after === -1) return { ...sorted[sorted.length - 1], offset }
  const a = sorted[after - 1]
  const b = sorted[after]
  const k = (offset - a.offset) / (b.offset - a.offset)
  const ca = hexChannels(a.color)
  const cb = hexChannels(b.color)
  const color = ca && cb ? channelsHex(ca.map((c, i) => c + (cb[i] - c) * k)) : a.color
  return { offset, color, opacity: a.opacity + (b.opacity - a.opacity) * k }
}

/** The stops the other way round: offsets flipped and their order reversed, so ties stay right. */
export function reverseStops(stops: readonly Stop[]): Stop[] {
  return stops.map((stop) => ({ ...stop, offset: 1 - stop.offset })).reverse()
}

/** The color a new gradient fades to from `color`: white, or black from a very light color. */
function partnerOf(color: string): string {
  const rgb = hexChannels(color)
  const light = rgb !== null && 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2] > 230
  return light ? '#000000' : '#ffffff'
}

/**
 * A gradient of `kind` made from a fill: a gradient keeps its stops, a solid fades from its color
 * to white (or black), and no fill from `fallback`. A linear gradient runs from left to right
 * across the middle of the box, a radial one from its middle out to half its longer side.
 */
export function gradientFrom(
  kind: Gradient['kind'],
  from: Paint | null,
  fallback: string,
): Gradient {
  if (from !== null && from.kind === kind) return from
  let stops: Stop[]
  if (isGradient(from)) stops = from.stops
  else {
    const raw = from === null ? fallback : from.color
    const color = isHexColor(raw) ? raw : '#000000'
    stops = [
      { offset: 0, color, opacity: 1 },
      { offset: 1, color: partnerOf(color), opacity: 1 },
    ]
  }
  return kind === 'linear'
    ? { kind, stops, start: [0, 0.5], end: [1, 0.5] }
    : { kind, stops, center: [0.5, 0.5], radius: 0.5 }
}

const boxWidth = (box: PaintBox) => box.maxX - box.minX
const boxHeight = (box: PaintBox) => box.maxY - box.minY

/** A point given in box units, in the box's own coordinates. */
export function fromBoxUnits(box: PaintBox, [u, v]: readonly [number, number]): Xy {
  return [box.minX + u * boxWidth(box), box.minY + v * boxHeight(box)]
}

/** A point in the box's coordinates, in box units; a side of no length counts as 1 unit long. */
export function toBoxUnits(box: PaintBox, [x, y]: readonly [number, number]): Xy {
  return [(x - box.minX) / (boxWidth(box) || 1), (y - box.minY) / (boxHeight(box) || 1)]
}

/** What a radial gradient's radius is in units of: the box's longer side. */
export function radiusUnit(box: PaintBox): number {
  return Math.max(boxWidth(box), boxHeight(box)) || 1
}

/** A gradient laid out in the coordinates of its box, with its stops in offset order. */
export type PlacedGradient =
  | { kind: 'linear'; stops: Stop[]; start: Xy; end: Xy }
  | { kind: 'radial'; stops: Stop[]; center: Xy; radius: number }

/**
 * The gradient in the coordinates of the box it is stored against: box units become pixels. Null
 * when it has no extent (both ends of a linear gradient on one point, or no radius), which canvas
 * would leave unpainted and SVG paints as its last stop; both then get the last stop (lastStop).
 */
export function placeGradient(paint: Gradient, box: PaintBox): PlacedGradient | null {
  const stops = sortedStops(paint.stops)
  if (paint.kind === 'linear') {
    const start = fromBoxUnits(box, paint.start)
    const end = fromBoxUnits(box, paint.end)
    if (!(Math.hypot(end[0] - start[0], end[1] - start[1]) > 1e-9)) return null
    return { kind: 'linear', stops, start, end }
  }
  const radius = paint.radius * radiusUnit(box)
  if (!(radius > 1e-9)) return null
  return { kind: 'radial', stops, center: fromBoxUnits(box, paint.center), radius }
}

/** The stop a gradient without extent is painted with: its last one along it. */
export function lastStop(paint: Gradient): Stop {
  const stops = sortedStops(paint.stops)
  return stops[stops.length - 1]
}

const samePair = (a: readonly [number, number], b: readonly [number, number]) =>
  a[0] === b[0] && a[1] === b[1]

/** Whether two lists of stops are the same, stop by stop. */
export const sameStops = (a: readonly Stop[], b: readonly Stop[]) =>
  a.length === b.length &&
  a.every(
    (stop, i) =>
      stop.offset === b[i].offset && stop.color === b[i].color && stop.opacity === b[i].opacity,
  )

/** Whether two fills paint the same, compared by value: a fresh solid equals one already set. */
export function samePaint(a: Paint | null, b: Paint | null): boolean {
  if (a === b) return true
  if (a === null || b === null) return false
  switch (a.kind) {
    case 'solid':
      return b.kind === 'solid' && a.color === b.color
    case 'linear':
      return (
        b.kind === 'linear' &&
        samePair(a.start, b.start) &&
        samePair(a.end, b.end) &&
        sameStops(a.stops, b.stops)
      )
    case 'radial':
      return (
        b.kind === 'radial' &&
        samePair(a.center, b.center) &&
        a.radius === b.radius &&
        sameStops(a.stops, b.stops)
      )
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value)

const isPair = (value: unknown): value is [number, number] =>
  Array.isArray(value) && value.length === 2 && value.every(isFiniteNumber)

// Stops take hex colors only: canvas throws on a gradient stop color it can't read.
function isStop(value: unknown): value is Stop {
  return (
    isObject(value) &&
    isFiniteNumber(value.offset) &&
    isHexColor(value.color) &&
    isFiniteNumber(value.opacity)
  )
}

const isStops = (value: unknown): value is Stop[] =>
  Array.isArray(value) && value.length > 0 && value.every(isStop)

/** Whether a loaded value is a paint the editor can draw. */
export function isPaint(value: unknown): value is Paint {
  if (!isObject(value)) return false
  switch (value.kind) {
    case 'solid':
      return typeof value.color === 'string'
    case 'linear':
      return isStops(value.stops) && isPair(value.start) && isPair(value.end)
    case 'radial':
      return isStops(value.stops) && isPair(value.center) && isFiniteNumber(value.radius)
    default:
      return false
  }
}
