import type Konva from 'konva'
import type { Ref } from 'react'
import { Circle, Group } from 'react-konva'

interface BrushCursorProps {
  ref?: Ref<Konva.Group>
  size: number
}

/**
 * Outline of the brush tip, drawn in canvas units so it scales with the Stage. CanvasStage moves
 * and shows it imperatively, so pointer moves don't re-render React.
 */
export function BrushCursor({ ref, size }: BrushCursorProps) {
  const radius = size / 2
  return (
    <Group ref={ref} visible={false} listening={false}>
      {/* A white halo under a dark ring keeps the outline visible on any color. */}
      <Circle radius={radius} stroke="#ffffff" strokeWidth={3} strokeScaleEnabled={false} />
      <Circle radius={radius} stroke="#111827" strokeWidth={1} strokeScaleEnabled={false} />
    </Group>
  )
}
