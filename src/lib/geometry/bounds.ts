import type { ShapeNode, Transform, VectorNode } from '../../types'

/** Anything with x at 0 and y at 1: a [x, y] pair or a [x, y, pressure] point. */
export type Vec = { readonly 0: number; readonly 1: number }

export interface Box {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

const DEG = Math.PI / 180

// perfect-freehand's outline reaches 0.75 × size at full pressure (thinning 0.5).
const MAX_STROKE_REACH = 0.75

export function isIdentity(t: Transform): boolean {
  return t.x === 0 && t.y === 0 && t.rotation === 0 && t.scaleX === 1 && t.scaleY === 1
}

/** Local → canvas coordinates, in Konva's order: scale, then rotate, then translate. */
export function applyTransform(t: Transform, x: number, y: number): [number, number] {
  const sx = x * t.scaleX
  const sy = y * t.scaleY
  if (t.rotation === 0) return [sx + t.x, sy + t.y]
  const cos = Math.cos(t.rotation * DEG)
  const sin = Math.sin(t.rotation * DEG)
  return [sx * cos - sy * sin + t.x, sx * sin + sy * cos + t.y]
}

/** Canvas → local coordinates: undoes applyTransform. */
export function invertTransform(t: Transform, x: number, y: number): [number, number] {
  let dx = x - t.x
  let dy = y - t.y
  if (t.rotation !== 0) {
    const cos = Math.cos(t.rotation * DEG)
    const sin = Math.sin(t.rotation * DEG)
    ;[dx, dy] = [dx * cos + dy * sin, dy * cos - dx * sin]
  }
  return [dx / t.scaleX, dy / t.scaleY]
}

/** The box around a list of points, grown by `pad` on every side. */
export function pointsBox(points: ReadonlyArray<Vec>, pad = 0): Box {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const { 0: x, 1: y } of points) {
    if (x < minX) minX = x
    if (y < minY) minY = y
    if (x > maxX) maxX = x
    if (y > maxY) maxY = y
  }
  return { minX: minX - pad, minY: minY - pad, maxX: maxX + pad, maxY: maxY + pad }
}

export function boxesOverlap(a: Box, b: Box): boolean {
  return a.minX <= b.maxX && b.minX <= a.maxX && a.minY <= b.maxY && b.minY <= a.maxY
}

/** The canvas box around a local box after the transform. */
function transformedBox(t: Transform, local: Box): Box {
  return pointsBox([
    applyTransform(t, local.minX, local.minY),
    applyTransform(t, local.maxX, local.minY),
    applyTransform(t, local.maxX, local.maxY),
    applyTransform(t, local.minX, local.maxY),
  ])
}

/** Length and width of a line's arrowhead, in canvas units: it grows with the line. */
export function arrowHeadSize(strokeWidth: number): number {
  return strokeWidth * 4 + 10
}

/** How far a shape's visible outline reaches past its geometry, in local units. */
export function outlineReach(node: ShapeNode): number {
  return node.style.stroke === null ? 0 : node.style.strokeWidth / 2
}

function shapeBounds(node: ShapeNode): Box {
  const t = node.transform
  const reach = outlineReach(node)
  switch (node.type) {
    case 'rect':
      return transformedBox(t, {
        minX: -reach,
        minY: -reach,
        maxX: node.width + reach,
        maxY: node.height + reach,
      })
    case 'ellipse': {
      // The exact box of a turned ellipse, from its half-axes.
      const a = (node.rx + reach) * Math.abs(t.scaleX)
      const b = (node.ry + reach) * Math.abs(t.scaleY)
      const cos = Math.cos(t.rotation * DEG)
      const sin = Math.sin(t.rotation * DEG)
      const hx = Math.hypot(a * cos, b * sin)
      const hy = Math.hypot(a * sin, b * cos)
      return { minX: t.x - hx, minY: t.y - hy, maxX: t.x + hx, maxY: t.y + hy }
    }
    case 'line': {
      const [x1, y1, x2, y2] = node.points
      // Round caps reach `reach` past the ends; arrowheads spread half their width to the sides.
      const arrows = node.arrowStart || node.arrowEnd
      const pad = arrows ? reach + arrowHeadSize(node.style.strokeWidth) / 2 : reach
      return transformedBox(
        t,
        pointsBox(
          [
            [x1, y1],
            [x2, y2],
          ],
          pad,
        ),
      )
    }
  }
}

const boundsCache = new WeakMap<VectorNode, Box | null>()

/**
 * Canvas-space box around a node's ink, outlines included; null for node types without bounds
 * yet (paths, text and groups get theirs in M11 and M12).
 */
export function nodeBounds(node: VectorNode): Box | null {
  const cached = boundsCache.get(node)
  if (cached !== undefined) return cached

  let box: Box | null = null
  if (node.type === 'stroke') {
    if (node.points.length > 0) {
      box = transformedBox(node.transform, pointsBox(node.points, node.size * MAX_STROKE_REACH))
    }
  } else if (node.type === 'rect' || node.type === 'ellipse' || node.type === 'line') {
    box = shapeBounds(node)
  }
  boundsCache.set(node, box)
  return box
}
