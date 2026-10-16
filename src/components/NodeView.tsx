import { memo } from 'react'
import { Path } from 'react-konva'
import { strokeToPath } from '../lib/strokePath'
import type { Point, StrokeNode, VectorNode } from '../types'

const DIMMED_OPACITY = 0.3
// Thin strokes are easy to grab: the hit area reaches this many screen pixels around the ink.
const HIT_STROKE_PX = 12

// Keyed by the points array: immer keeps it as the same object while a stroke is moved, rotated
// or restyled, so its outline is computed once, even across undo and redo.
const pathCache = new WeakMap<Point[], { size: number; usesPressure: boolean; data: string }>()

function cachedStrokePath(node: StrokeNode): string {
  const cached = pathCache.get(node.points)
  if (cached && cached.size === node.size && cached.usesPressure === node.usesPressure) {
    return cached.data
  }
  const data = strokeToPath(node)
  pathCache.set(node.points, { size: node.size, usesPressure: node.usesPressure, data })
  return data
}

interface NodeViewProps {
  node: VectorNode
  dimmed?: boolean // touched by the eraser, about to be deleted
  isDraft?: boolean // still being drawn
}

/**
 * One Konva shape per node, named by the node id so tools can tell what was hit. Hits only count
 * while the content layer listens, which only tools that pick nodes turn on.
 */
export const NodeView = memo(function NodeView({
  node,
  dimmed = false,
  isDraft = false,
}: NodeViewProps) {
  if (node.hidden) return null
  const { transform, style } = node
  const common = {
    id: node.id,
    x: transform.x,
    y: transform.y,
    rotation: transform.rotation,
    scaleX: transform.scaleX,
    scaleY: transform.scaleY,
    opacity: style.opacity * (dimmed ? DIMMED_OPACITY : 1),
    listening: !node.locked && !isDraft,
    perfectDrawEnabled: false,
  }

  switch (node.type) {
    case 'stroke':
      return (
        <Path
          {...common}
          data={isDraft ? strokeToPath(node, false) : cachedStrokePath(node)}
          fill={style.fill ?? undefined}
          // The outline is a fill, so the hit stroke has no visible twin; unscaled, it stays
          // HIT_STROKE_PX on screen at any zoom and any stroke scale.
          hitStrokeWidth={HIT_STROKE_PX}
          strokeScaleEnabled={false}
        />
      )
    // Shapes, paths, text and groups render from their own milestones on (M10–M12).
    default:
      return null
  }
})
