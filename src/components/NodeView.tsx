import { memo } from 'react'
import { Path } from 'react-konva'
import { strokeToPath } from '../lib/strokePath'
import type { StrokeNode, VectorNode } from '../types'

const DIMMED_OPACITY = 0.3

// Keyed by node object: immer keeps unchanged nodes as the same object, so their outline is
// computed once, even across undo and redo.
const pathCache = new WeakMap<StrokeNode, string>()

function cachedStrokePath(node: StrokeNode): string {
  let data = pathCache.get(node)
  if (data === undefined) {
    data = strokeToPath(node)
    pathCache.set(node, data)
  }
  return data
}

interface NodeViewProps {
  node: VectorNode
  dimmed?: boolean // touched by the eraser, about to be deleted
  isDraft?: boolean // still being drawn
}

export const NodeView = memo(function NodeView({
  node,
  dimmed = false,
  isDraft = false,
}: NodeViewProps) {
  if (node.hidden) return null
  const { transform, style } = node
  const common = {
    x: transform.x,
    y: transform.y,
    rotation: transform.rotation,
    scaleX: transform.scaleX,
    scaleY: transform.scaleY,
    opacity: style.opacity * (dimmed ? DIMMED_OPACITY : 1),
    listening: false,
    perfectDrawEnabled: false,
  }

  switch (node.type) {
    case 'stroke':
      return (
        <Path
          {...common}
          data={isDraft ? strokeToPath(node, false) : cachedStrokePath(node)}
          fill={style.fill ?? undefined}
        />
      )
    // Shapes, paths, text and groups render from their own milestones on (M10–M12).
    default:
      return null
  }
})
