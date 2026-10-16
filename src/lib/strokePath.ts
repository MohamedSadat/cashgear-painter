import { getStroke } from 'perfect-freehand'
import type { StrokeNode } from '../types'

const average = (a: number, b: number) => (a + b) / 2

/** Turns a perfect-freehand outline into a closed SVG path of quadratic curves. */
export function getSvgPathFromStroke(outline: number[][]): string {
  const len = outline.length
  if (len < 4) return ''

  let a = outline[0]
  let b = outline[1]
  const c = outline[2]
  let result = `M${a[0].toFixed(2)},${a[1].toFixed(2)} Q${b[0].toFixed(2)},${b[1].toFixed(2)} ${average(b[0], c[0]).toFixed(2)},${average(b[1], c[1]).toFixed(2)} T`

  for (let i = 2, max = len - 1; i < max; i++) {
    a = outline[i]
    b = outline[i + 1]
    result += `${average(a[0], b[0]).toFixed(2)},${average(a[1], b[1]).toFixed(2)} `
  }

  return `${result}Z`
}

/** SVG path data for a stroke's filled outline. `last` is false while the stroke is still being drawn. */
export function strokeToPath(
  stroke: Pick<StrokeNode, 'points' | 'size' | 'usesPressure'>,
  last = true,
): string {
  if (stroke.points.length === 0) return ''
  const outline = getStroke(stroke.points, {
    size: stroke.size,
    thinning: 0.5,
    smoothing: 0.5,
    streamline: 0.5,
    simulatePressure: !stroke.usesPressure,
    last,
  })
  return getSvgPathFromStroke(outline)
}
