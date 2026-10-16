import type Konva from 'konva'
import type { Ref } from 'react'
import { Circle, Group } from 'react-konva'
import type { ToolId } from '../types'

// The tools that paint or erase with the brush size.
const BRUSH_TOOLS: ReadonlySet<ToolId> = new Set(['brush', 'eraser'])

interface BrushCursorProps {
  ref?: Ref<Konva.Group>
  tool: ToolId
  size: number
}

/**
 * Outline of the brush tip on the overlay layer. Its radius is in canvas units, so it matches the
 * stroke at any zoom, while the outline stays 1 screen pixel wide. CanvasStage moves and shows it
 * imperatively, so pointer moves don't re-render React. Other tools get no tip outline.
 */
export function BrushCursor({ ref, tool, size }: BrushCursorProps) {
  if (!BRUSH_TOOLS.has(tool)) return null
  const radius = size / 2
  return (
    <Group ref={ref} visible={false} listening={false}>
      {/* A white halo under a dark ring keeps the outline visible on any color. */}
      <Circle radius={radius} stroke="#ffffff" strokeWidth={3} strokeScaleEnabled={false} />
      <Circle radius={radius} stroke="#111827" strokeWidth={1} strokeScaleEnabled={false} />
    </Group>
  )
}
