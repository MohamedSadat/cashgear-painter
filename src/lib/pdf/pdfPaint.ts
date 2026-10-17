import { isGradient } from '../paint/paint'
import type { Paint, Stop, VectorNode } from '../../types'

/**
 * Whether svg2pdf.js can't draw the node as the canvas does, so the PDF shows a picture of it:
 * text filled with a gradient (svg2pdf.js fills text with solid colors only), and gradients with
 * see-through stops (PDF shadings have no opacity, and svg2pdf.js fades the whole shape by an
 * average instead).
 */
export function needsPicture(node: VectorNode): boolean {
  const { fill } = node.style
  if (node.type === 'group' || node.type === 'image' || node.type === 'line') return false
  if (!isGradient(fill)) return false
  return node.type === 'text' || fill.stops.some((stop) => stop.opacity < 1)
}

const hex = (n: number) =>
  Math.round(Math.min(255, Math.max(0, n)))
    .toString(16)
    .padStart(2, '0')

/** A stop's color laid over white, as a page's paper shows it. */
function stopOverWhite({ offset, color, opacity }: Stop): Stop {
  if (opacity >= 1) return { offset, color, opacity }
  const a = Math.max(0, opacity)
  const channels = [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16))
  const mixed = channels.map((c) => hex(c * a + 255 * (1 - a)))
  return { offset, color: `#${mixed.join('')}`, opacity: 1 }
}

/**
 * A page background as it shows on white paper, see-through stops made solid, so svg2pdf.js
 * draws it as the canvas does. Stops are #rrggbb or #rgb (isPaint), so #rgb is widened first.
 */
export function overWhite(paint: Paint): Paint {
  if (!isGradient(paint) || paint.stops.every((stop) => stop.opacity >= 1)) return paint
  const wide = (color: string) =>
    color.length === 4 ? `#${[...color.slice(1)].map((c) => c + c).join('')}` : color
  return {
    ...paint,
    stops: paint.stops.map((stop) => stopOverWhite({ ...stop, color: wide(stop.color) })),
  }
}
