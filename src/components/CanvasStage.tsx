import type Konva from 'konva'
import type { KonvaEventObject } from 'konva/lib/Node'
import { useCallback, useEffect, useMemo, useRef, type Ref } from 'react'
import { Layer, Rect, Stage } from 'react-konva'
import { useViewport } from '../hooks/useViewport'
import { OVERLAY_LAYER_NAME } from '../lib/exportPng'
import { useEditorStore } from '../store/editorStore'
import { toolFor } from '../tools'
import { finishTextEdit } from '../tools/textTool'
import type { ToolEvent } from '../tools/types'
import { CANVAS_HEIGHT, CANVAS_WIDTH, type NodeId } from '../types'
import { BrushCursor } from './BrushCursor'
import { NodeView } from './NodeView'
import { PathEditOverlay } from './PathEditOverlay'
import { SelectionOverlay } from './SelectionOverlay'
import { TextEditor } from './TextEditor'

interface CanvasStageProps {
  stageRef: Ref<Konva.Stage>
}

const PASTEBOARD_COLOR = '#e5e5e5'
const ARTBOARD_EDGE_COLOR = '#d4d4d4'

const activeTool = () => toolFor(useEditorStore.getState().tool)

/** A pointer event in canvas units, ready for the active tool. */
function readToolEvent(
  layer: Konva.Layer | null,
  evt: PointerEvent,
  target: NodeId | null = null,
): ToolEvent | null {
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
    target,
    timeStamp: evt.timeStamp,
  }
}

export function CanvasStage({ stageRef }: CanvasStageProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const contentLayerRef = useRef<Konva.Layer>(null)
  const cursorRef = useRef<Konva.Group>(null)
  const activePointerId = useRef<number | null>(null)
  const lastEvent = useRef<ToolEvent | null>(null)
  const doc = useEditorStore((s) => s.doc)
  const draft = useEditorStore((s) => s.draft)
  const erasing = useEditorStore((s) => s.erasing)
  const tool = useEditorStore((s) => s.tool)
  const size = useEditorStore((s) => s.brush.size)
  const view = useEditorStore((s) => s.view)
  const viewport = useEditorStore((s) => s.viewport)
  const erasingIds = useMemo(() => new Set(erasing), [erasing])
  const zoom = viewport.fit * view.scale

  // A pinch is not a stroke: drop whatever the first finger started.
  const cancelGesture = useCallback(() => {
    if (activePointerId.current === null) return
    activePointerId.current = null
    activeTool()?.onCancel?.()
  }, [])
  useViewport(containerRef, cancelGesture)

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

  const handlePointerLeave = () => {
    cursorRef.current?.visible(false)
    activeTool()?.onHover?.(null)
  }

  const handlePointerDown = ({ evt, target }: KonvaEventObject<PointerEvent>) => {
    // A tap is followed by emulated mouse events, whose mousedown would take the focus from a
    // text editor the tap has just opened; cancelling the pointerdown drops them.
    if (evt.pointerType !== 'mouse' && evt.cancelable) evt.preventDefault()
    moveCursor(evt)
    // Ignore a second finger while a gesture is in progress, and any mouse button but the main one.
    if (activePointerId.current !== null) return
    if (evt.pointerType === 'mouse' && evt.button !== 0) return
    // A press on the canvas while a text is being edited only ends the edit; a tap may not blur
    // the textarea on touch screens.
    if (useEditorStore.getState().editingText !== null) {
      finishTextEdit()
      return
    }
    const content = contentLayerRef.current
    // A press on the overlay (the Transformer's handles) is the overlay's own drag.
    const layer = target.getLayer()
    if (layer && layer !== content) return
    // Only shapes on a listening content layer are hit; otherwise the target is the Stage.
    const targetId = layer === content ? target.id() || null : null
    const e = readToolEvent(content, evt, targetId)
    const active = activeTool()
    if (!e || !active) return
    activePointerId.current = evt.pointerId
    lastEvent.current = e
    active.onDown(e)
  }

  const handlePointerMove = ({ evt }: KonvaEventObject<PointerEvent>) => {
    moveCursor(evt)
    if (activePointerId.current === null && evt.pointerType !== 'touch') {
      const hover = activeTool()?.onHover
      if (hover) hover(readToolEvent(contentLayerRef.current, evt))
      return
    }
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
    // The padding only shapes the fit; the Stage fills the whole area, padding included.
    // A browser keeping the text editor's caret in view may scroll this box; the view does the
    // panning here, so it goes straight back.
    <div
      ref={containerRef}
      className="relative min-h-0 min-w-0 flex-1 touch-none overflow-hidden p-2 select-none [-webkit-touch-callout:none] sm:p-4"
      onScroll={(e) => e.currentTarget.scrollTo(0, 0)}
    >
      {viewport.fit > 0 && (
        <div
          className="absolute inset-0"
          style={{ cursor: toolFor(tool)?.cursor ?? 'default' }}
          data-testid="canvas"
          onPointerLeave={handlePointerLeave}
        >
          <Stage
            ref={stageRef}
            width={viewport.width}
            height={viewport.height}
            scaleX={zoom}
            scaleY={zoom}
            x={view.x}
            y={view.y}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
          >
            <Layer listening={false}>
              {/* The pasteboard covers the visible area, so it is sized in canvas units here. */}
              <Rect
                x={-view.x / zoom}
                y={-view.y / zoom}
                width={viewport.width / zoom}
                height={viewport.height / zoom}
                fill={PASTEBOARD_COLOR}
              />
              {/* A 1-screen-pixel edge and a soft shadow, both outside the artboard and the PNG. */}
              <Rect
                x={-1 / zoom}
                y={-1 / zoom}
                width={CANVAS_WIDTH + 2 / zoom}
                height={CANVAS_HEIGHT + 2 / zoom}
                fill={ARTBOARD_EDGE_COLOR}
                shadowColor="#000000"
                shadowOpacity={0.15}
                shadowBlur={8 / zoom}
                shadowOffsetY={2 / zoom}
              />
              <Rect
                name="artboard"
                width={CANVAS_WIDTH}
                height={CANVAS_HEIGHT}
                fill={doc.background}
              />
            </Layer>
            {/* The draft is the last child, so the stroke being drawn is on top. */}
            <Layer ref={contentLayerRef} listening={toolFor(tool)?.picksNodes ?? false}>
              {doc.rootIds.map((id) => (
                <NodeView key={id} node={doc.nodes[id]} dimmed={erasingIds.has(id)} />
              ))}
              {draft && <NodeView key={draft.id} node={draft} isDraft />}
            </Layer>
            <Layer name={OVERLAY_LAYER_NAME}>
              <SelectionOverlay contentLayerRef={contentLayerRef} />
              <PathEditOverlay />
              <BrushCursor ref={cursorRef} tool={tool} size={size} />
            </Layer>
          </Stage>
          <TextEditor />
        </div>
      )}
    </div>
  )
}
