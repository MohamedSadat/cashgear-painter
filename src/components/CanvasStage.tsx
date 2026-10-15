import type Konva from 'konva'
import type { KonvaEventObject } from 'konva/lib/Node'
import { useEffect, useMemo, useRef, type Ref } from 'react'
import { Layer, Rect, Stage } from 'react-konva'
import { useFitScale } from '../hooks/useFitScale'
import { CURSOR_LAYER_NAME } from '../lib/exportPng'
import { useEditorStore } from '../store/editorStore'
import { toolFor } from '../tools'
import type { ToolEvent } from '../tools/types'
import { CANVAS_HEIGHT, CANVAS_WIDTH } from '../types'
import { BrushCursor } from './BrushCursor'
import { NodeView } from './NodeView'

interface CanvasStageProps {
  stageRef: Ref<Konva.Stage>
}

const activeTool = () => toolFor(useEditorStore.getState().tool)

/** A pointer event in canvas units, ready for the active tool. */
function readToolEvent(layer: Konva.Layer | null, evt: PointerEvent): ToolEvent | null {
  // Relative to the layer, so the point is in canvas units at any stage scale.
  const pos = layer?.getRelativePointerPosition()
  if (!pos) return null
  return {
    point: [pos.x, pos.y],
    // Mice and fingers report a constant pressure; only pens use theirs, the rest is simulated.
    pressure: evt.pointerType === 'pen' && evt.pressure > 0 ? evt.pressure : 0.5,
    pointerType: evt.pointerType,
    shift: evt.shiftKey,
    alt: evt.altKey,
    mod: evt.ctrlKey || evt.metaKey,
    target: null,
  }
}

export function CanvasStage({ stageRef }: CanvasStageProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const contentLayerRef = useRef<Konva.Layer>(null)
  const cursorRef = useRef<Konva.Group>(null)
  const activePointerId = useRef<number | null>(null)
  const lastEvent = useRef<ToolEvent | null>(null)
  const scale = useFitScale(containerRef)
  const doc = useEditorStore((s) => s.doc)
  const draft = useEditorStore((s) => s.draft)
  const erasing = useEditorStore((s) => s.erasing)
  const tool = useEditorStore((s) => s.tool)
  const size = useEditorStore((s) => s.brush.size)
  const erasingIds = useMemo(() => new Set(erasing), [erasing])

  // End the gesture even when the pointer is released off the canvas.
  useEffect(() => {
    const finish = (evt: PointerEvent) => {
      if (evt.pointerId !== activePointerId.current) return
      activePointerId.current = null
      const layer = contentLayerRef.current
      layer?.getStage().setPointersPositions(evt)
      const e = readToolEvent(layer, evt) ?? lastEvent.current
      if (e) activeTool()?.onUp(e)
    }
    window.addEventListener('pointerup', finish)
    window.addEventListener('pointercancel', finish)
    return () => {
      window.removeEventListener('pointerup', finish)
      window.removeEventListener('pointercancel', finish)
    }
  }, [])

  // Switching tools mid-drag cancels what the old tool was doing.
  useEffect(
    () =>
      useEditorStore.subscribe((state, previous) => {
        if (state.tool === previous.tool) return
        toolFor(previous.tool)?.onCancel?.()
        activePointerId.current = null
      }),
    [],
  )

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
    // Ignore a second finger while a gesture is in progress, and any mouse button but the main one.
    if (activePointerId.current !== null) return
    if (evt.pointerType === 'mouse' && evt.button !== 0) return
    const e = readToolEvent(contentLayerRef.current, evt)
    const active = activeTool()
    if (!e || !active) return
    activePointerId.current = evt.pointerId
    lastEvent.current = e
    active.onDown(e)
  }

  const handlePointerMove = ({ evt }: KonvaEventObject<PointerEvent>) => {
    moveCursor(evt)
    if (evt.pointerId !== activePointerId.current) return
    const e = readToolEvent(contentLayerRef.current, evt)
    if (!e) return
    lastEvent.current = e
    activeTool()?.onMove(e)
  }

  const handlePointerUp = ({ evt }: KonvaEventObject<PointerEvent>) => {
    if (evt.pointerId !== activePointerId.current) return
    activePointerId.current = null
    const e = readToolEvent(contentLayerRef.current, evt) ?? lastEvent.current
    if (e) activeTool()?.onUp(e)
  }

  return (
    <div
      ref={containerRef}
      className="flex min-h-0 flex-1 touch-none items-center justify-center overflow-hidden p-2 select-none [-webkit-touch-callout:none] sm:p-4"
    >
      {scale > 0 && (
        <div
          className="shadow-md ring-1 ring-black/10"
          style={{ cursor: toolFor(tool)?.cursor ?? 'default' }}
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
            <Layer listening={false}>
              <Rect width={CANVAS_WIDTH} height={CANVAS_HEIGHT} fill={doc.background} />
            </Layer>
            {/* The draft is the last child, so the stroke being drawn is on top. */}
            <Layer ref={contentLayerRef} listening={false}>
              {doc.rootIds.map((id) => (
                <NodeView key={id} node={doc.nodes[id]} dimmed={erasingIds.has(id)} />
              ))}
              {draft && <NodeView key={draft.id} node={draft} isDraft />}
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
