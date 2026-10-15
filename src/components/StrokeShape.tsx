import { memo, useMemo } from 'react'
import { Path } from 'react-konva'
import { strokeToPath } from '../lib/strokePath'
import type { Stroke } from '../types'

interface StrokeShapeProps {
  stroke: Stroke
  isDraft?: boolean
}

export const StrokeShape = memo(function StrokeShape({
  stroke,
  isDraft = false,
}: StrokeShapeProps) {
  const data = useMemo(() => strokeToPath(stroke, !isDraft), [stroke, isDraft])
  const isEraser = stroke.tool === 'eraser'

  return (
    <Path
      data={data}
      fill={isEraser ? '#000000' : stroke.color}
      // destination-out cuts through the strokes layer and reveals the white background layer below.
      globalCompositeOperation={isEraser ? 'destination-out' : 'source-over'}
      listening={false}
      perfectDrawEnabled={false}
    />
  )
})
