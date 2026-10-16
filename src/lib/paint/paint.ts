import type { Paint, Stop } from '../../types'

export function solid(color: string): Paint {
  return { kind: 'solid', color }
}

/**
 * The one color that stands for a paint: a solid's own, or a gradient's first stop. Gradients
 * render as that color until they are drawn as gradients (M18).
 */
export function paintColor(paint: Paint): string {
  return paint.kind === 'solid' ? paint.color : (paint.stops[0]?.color ?? '#000000')
}

/** A fill as Konva's color attribute: undefined for no fill. */
export function fillColor(fill: Paint | null): string | undefined {
  return fill === null ? undefined : paintColor(fill)
}

const samePair = (a: readonly [number, number], b: readonly [number, number]) =>
  a[0] === b[0] && a[1] === b[1]

const sameStops = (a: readonly Stop[], b: readonly Stop[]) =>
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

function isStop(value: unknown): value is Stop {
  return (
    isObject(value) &&
    isFiniteNumber(value.offset) &&
    typeof value.color === 'string' &&
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
