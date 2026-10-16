import type { Anchor, Transform, VectorNode } from '../../types'

/** Degrees in (-180, 180], so a full turn back reads as no rotation. */
export function normalizeRotation(degrees: number): number {
  const turned = (((degrees % 360) + 540) % 360) - 180
  // Rounding hides float noise such as 89.99999999999999 from Konva's matrix math.
  const rounded = Math.round(turned * 1e6) / 1e6
  return rounded === -180 ? 180 : rounded
}

export function sameTransform(a: Transform, b: Transform): boolean {
  return (
    a.x === b.x &&
    a.y === b.y &&
    a.rotation === b.rotation &&
    a.scaleX === b.scaleX &&
    a.scaleY === b.scaleY
  )
}

function scaleAnchor(a: Anchor, sx: number, sy: number): Anchor {
  return {
    ...a,
    x: a.x * sx,
    y: a.y * sy,
    inX: a.inX * sx,
    inY: a.inY * sy,
    outX: a.outX * sx,
    outY: a.outY * sy,
  }
}

/**
 * The changes that give `node` the transform `next`, as a Transformer leaves it. Scale is baked
 * into geometry and reset to 1, so outlines keep their width: sizes for rects and ellipses, points
 * for lines, anchors and handles for paths, and width and font size for text (corner handles
 * scale both, side handles only the width). Freehand strokes and groups keep their scale, since a
 * stroke's outline is a fill and scales correctly. Null when nothing changes.
 */
export function bakeTransform(node: VectorNode, next: Transform): Partial<VectorNode> | null {
  const { scaleX: sx, scaleY: sy } = next
  if (node.type === 'stroke' || node.type === 'group' || (sx === 1 && sy === 1)) {
    return sameTransform(next, node.transform) ? null : { transform: next }
  }

  const transform: Transform = { ...next, scaleX: 1, scaleY: 1 }
  switch (node.type) {
    case 'rect':
      return { transform, width: node.width * Math.abs(sx), height: node.height * Math.abs(sy) }
    case 'ellipse':
      return { transform, rx: node.rx * Math.abs(sx), ry: node.ry * Math.abs(sy) }
    case 'line': {
      const [x1, y1, x2, y2] = node.points
      return { transform, points: [x1 * sx, y1 * sy, x2 * sx, y2 * sy] }
    }
    case 'path':
      return { transform, anchors: node.anchors.map((a) => scaleAnchor(a, sx, sy)) }
    case 'text':
      return { transform, width: node.width * Math.abs(sx), fontSize: node.fontSize * Math.abs(sy) }
  }
}
