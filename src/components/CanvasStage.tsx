import type Konva from 'konva'
import type { KonvaEventObject } from 'konva/lib/Node'
import { useEffect, useRef, type Ref } from 'react'
import { Layer, Rect, Stage } from 'react-konva'
import { useFitScale } from '../hooks/useFitScale'
import { CURSOR_LAYER_NAME } from '../lib/exportPng'
import { usePaintStore } from '../store/paintStore'
import { CANVAS_HEIGHT, CANVAS_WIDTH, type Point } from '../types'
import { BrushCursor } from './BrushCursor'
import { StrokeShape } from './StrokeShape'

interface CanvasStageProps {
  stageRef: Ref<Konva.Stage>
}

export function CanvasStage({ stageRef }: CanvasStageProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const strokesLayerRef = useRef<Konva.Layer>(null)
  const cursorRef = useRef<Konva.Group>(null)
  const activePointerId = useRef<number | null>(null)
  const scale = useFitScale(containerRef)
  const strokes = usePaintStore((s) => s.strokes)
  const draft = usePaintStore((s) => s.draft)
  const size = usePaintStore((s) => s.size)

  // End the stroke even when the pointer is released off the canvas.
  useEffect(() => {
    const finish = (evt: PointerEvent) => {
      if (evt.pointerId !== activePointerId.current) return
      activePointerId.current = null
      usePaintStore.getState().endStroke()
    }
    window.addEventListener('pointerup', finish)
    window.addEventListener('pointercancel', finish)
    return () => {
      window.removeEventListener('pointerup', finish)
      window.removeEventListener('pointercancel', finish)
    }
  }, [])

  const readPoint = (evt: PointerEvent): Point | null => {
    // Relative to the layer, so the point is in canvas units at any stage scale.
    const pos = strokesLayerRef.current?.getRelativePointerPosition()
    if (!pos) return null
    // Mice and fingers report a constant pressure; only pens use theirs, the rest is simulated.
    const pressure = evt.pointerType === 'pen' && evt.pressure > 0 ? evt.pressure : 0.5
    return [pos.x, pos.y, pressure]
  }

  const moveCursor = (evt: PointerEvent) => {
    const cursor = cursorRef.current
    if (!cursor) return
    if (evt.pointerType === 'touch') {
      cursor.visible(false)
      return
    }
    const pos = cursor.getLayer()?.getRelativePointerPosition()
    if (!pos) return
    cursor.position(pos)
    cursor.visible(true)
  }

  const hideCursor = () => {
    cursorRef.current?.visible(false)
  }

  const handlePointerDown = ({ evt }: KonvaEventObject<PointerEvent>) => {
    moveCursor(evt)
    // Ignore a second finger while a stroke is in progress, and any mouse button but the main one.
    if (activePointerId.current !== null) return
    if (evt.pointerType === 'mouse' && evt.button !== 0) return
    const point = readPoint(evt)
    if (!point) return
    activePointerId.current = evt.pointerId
    usePaintStore.getState().beginStroke(point, evt.pointerType)
  }

  const handlePointerMove = ({ evt }: KonvaEventObject<PointerEvent>) => {
    moveCursor(evt)
    if (evt.pointerId !== activePointerId.current) return
    const point = readPoint(evt)
    if (point) usePaintStore.getState().extendStroke(point)
  }

  const handlePointerUp = ({ evt }: KonvaEventObject<PointerEvent>) => {
    if (evt.pointerId !== activePointerId.current) return
    activePointerId.current = null
    usePaintStore.getState().endStroke()
  }

  return (
    <div
      ref={containerRef}
      className="flex min-h-0 flex-1 touch-none items-center justify-center overflow-hidden p-2 select-none [-webkit-touch-callout:none] sm:p-4"
    >
      {scale > 0 && (
        <div
          className="cursor-crosshair shadow-md ring-1 ring-black/10"
          data-testid="canvas"
          onPointerLeave={hideCursor}
        >
          <Stage
            ref={stageRef}
            width={CANVAS_WIDTH * scale}
            height={CANVAS_HEIGHT * scale}
            scaleX={scale}
            scaleY={scale}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
          >
            {/* Kept in its own layer so the eraser never cuts holes in it. */}
            <Layer listening={false}>
              <Rect width={CANVAS_WIDTH} height={CANVAS_HEIGHT} fill="#ffffff" />
            </Layer>
            {/* The draft is the last child here, so a live eraser stroke cuts this layer too. */}
            <Layer ref={strokesLayerRef} listening={false}>
              {strokes.map((stroke) => (
                <StrokeShape key={stroke.id} stroke={stroke} />
              ))}
              {draft && <StrokeShape key={draft.id} stroke={draft} isDraft />}
            </Layer>
            <Layer name={CURSOR_LAYER_NAME} listening={false}>
              <BrushCursor ref={cursorRef} size={size} />
            </Layer>
          </Stage>
        </div>
      )}
    </div>
  )
}
