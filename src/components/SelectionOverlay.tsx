import type Konva from 'konva'
import type { KonvaEventObject } from 'konva/lib/Node'
import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react'
import { Circle, Rect, Transformer } from 'react-konva'
import { applyTransform, invertTransform } from '../lib/geometry/bounds'
import { bakeTransform, normalizeRotation, snapAngle } from '../lib/geometry/transform'
import { useEditorStore, zoomOf } from '../store/editorStore'
import type { NodeId, NodeOf, VectorNode } from '../types'

const ACCENT = '#0ea5e9'
const ALL_ANCHORS = [
  'top-left',
  'top-center',
  'top-right',
  'middle-right',
  'middle-left',
  'bottom-left',
  'bottom-center',
  'bottom-right',
]
const CORNER_ANCHORS = ['top-left', 'top-right', 'bottom-left', 'bottom-right']
const MIN_SIZE_PX = 2 // smallest box a resize may leave, in screen pixels

// Konva's matrix math leaves noise such as 0.9999999999999997 on axes nobody scaled.
const roundScale = (scale: number) => Math.round(scale * 1e6) / 1e6

// Fingers need bigger handles than mice.
const coarsePointer = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches
const ANCHOR_SIZE = coarsePointer ? 18 : 9
// Screen pixels between the ink and the box, so a thin stroke's middle handles don't cover it
// and a press on the stroke moves it instead of stretching it.
const BOX_PADDING = ANCHOR_SIZE / 2 + 4
// Screen pixels of extra grip around a line's end handles.
const END_GRIP = coarsePointer ? 16 : 8

const store = () => useEditorStore.getState()

/** Moves one end of a line to where its handle was dragged; Shift snaps the line to 45°. */
function dragLineEnd(id: NodeId, end: 0 | 1, e: KonvaEventObject<DragEvent>) {
  const line = store().doc.nodes[id]
  if (line?.type !== 'line') return
  const t = line.transform
  const [x1, y1, x2, y2] = line.points
  const fixed = end === 0 ? applyTransform(t, x2, y2) : applyTransform(t, x1, y1)
  let moved: [number, number] = [e.target.x(), e.target.y()]
  if (e.evt.shiftKey) {
    moved = snapAngle(fixed, moved)
    e.target.position({ x: moved[0], y: moved[1] })
  }
  const [x, y] = invertTransform(t, moved[0], moved[1])
  const points: NodeOf<'line'>['points'] = end === 0 ? [x, y, x2, y2] : [x1, y1, x, y]
  store().updateNodes({ [id]: { points } })
}

/**
 * A handle on each end of a single selected line; dragging one moves that end, as one undo step.
 * Lines get these instead of the Transformer, whose box has no height for a level line and so
 * could not turn or stretch it.
 */
function LineEnds({ line, listening }: { line: NodeOf<'line'>; listening: boolean }) {
  const zoom = useEditorStore(zoomOf)
  const dragging = useRef(false)
  // A drag cut short by the handles going away (a shortcut that changes the selection) still
  // closes its undo step.
  useEffect(
    () => () => {
      if (dragging.current) store().endGesture()
    },
    [],
  )
  const [x1, y1, x2, y2] = line.points
  const ends = [applyTransform(line.transform, x1, y1), applyTransform(line.transform, x2, y2)]
  return ends.map(([x, y], end) => (
    <Circle
      key={end}
      name={end === 0 ? 'line-start' : 'line-end'}
      x={x}
      y={y}
      radius={ANCHOR_SIZE / 2 / zoom}
      fill="#ffffff"
      stroke={ACCENT}
      strokeWidth={1}
      strokeScaleEnabled={false}
      hitStrokeWidth={END_GRIP}
      listening={listening}
      draggable
      onDragStart={() => {
        dragging.current = true
        store().beginGesture()
      }}
      onDragMove={(e) => dragLineEnd(line.id, end === 0 ? 0 : 1, e)}
      onDragEnd={() => {
        dragging.current = false
        store().endGesture()
      }}
    />
  ))
}

interface SelectionOverlayProps {
  contentLayerRef: RefObject<Konva.Layer | null>
}

/**
 * The selection's Transformer, a single line's end handles and the select tool's marquee, on the
 * overlay layer. Konva draws the Transformer at a constant screen size, keeps the ratio and snaps
 * rotation to 15° while Shift is held. On transformend the new transforms go to the store as one
 * undo step, with scale baked into geometry where the node type allows.
 */
export function SelectionOverlay({ contentLayerRef }: SelectionOverlayProps) {
  const transformerRef = useRef<Konva.Transformer>(null)
  const doc = useEditorStore((s) => s.doc)
  const selection = useEditorStore((s) => s.selection)
  const tool = useEditorStore((s) => s.tool)
  const marquee = useEditorStore((s) => s.marquee)
  // Handles only work with the select tool; panning with Space keeps them in view.
  const shown = tool === 'select' || tool === 'hand'
  const single = selection.length === 1 ? doc.nodes[selection[0]] : undefined
  const line = shown && single?.type === 'line' && !single.hidden ? single : null

  // Konva's multi-node box is axis-aligned, so stretching one axis would skew rotated nodes.
  const freeAspect =
    selection.length <= 1 ||
    selection.every((id) => (doc.nodes[id]?.transform.rotation ?? 0) % 90 === 0)

  useLayoutEffect(() => {
    const transformer = transformerRef.current
    const layer = contentLayerRef.current
    if (!transformer || !layer) return
    const wanted = new Set<NodeId>(shown && !line ? selection : [])
    const shapes = wanted.size === 0 ? [] : layer.find((node: Konva.Node) => wanted.has(node.id()))
    transformer.nodes(shapes)
    // Path data and other geometry changes don't notify the Transformer by themselves.
    transformer.forceUpdate()
    transformer.getLayer()?.batchDraw()
  }, [contentLayerRef, doc, selection, shown, line])

  const handleTransformEnd = () => {
    const transformer = transformerRef.current
    if (!transformer) return
    const { doc, updateNodes } = useEditorStore.getState()
    const patch: Record<NodeId, Partial<VectorNode>> = {}
    for (const shape of transformer.nodes()) {
      const node = doc.nodes[shape.id()]
      if (!node) continue
      const changes = bakeTransform(node, {
        x: shape.x(),
        y: shape.y(),
        rotation: normalizeRotation(shape.rotation()),
        scaleX: roundScale(shape.scaleX()),
        scaleY: roundScale(shape.scaleY()),
      })
      const t = changes?.transform ?? node.transform
      // React only sets props that differ from its last render, so Konva must already hold the
      // model's values: a baked scale goes back to 1, and any skew is dropped.
      shape.setAttrs({ ...t, skewX: 0, skewY: 0 })
      if (changes) patch[node.id] = changes
    }
    updateNodes(patch)
  }

  return (
    <>
      <Transformer
        ref={transformerRef}
        listening={tool === 'select'}
        flipEnabled={false}
        ignoreStroke
        keepRatio={!freeAspect}
        enabledAnchors={freeAspect ? ALL_ANCHORS : CORNER_ANCHORS}
        padding={BOX_PADDING}
        anchorSize={ANCHOR_SIZE}
        anchorCornerRadius={2}
        anchorStroke={ACCENT}
        borderStroke={ACCENT}
        boundBoxFunc={(oldBox, newBox) =>
          Math.abs(newBox.width) < MIN_SIZE_PX || Math.abs(newBox.height) < MIN_SIZE_PX
            ? oldBox
            : newBox
        }
        onTransformEnd={handleTransformEnd}
      />
      {line && <LineEnds key={line.id} line={line} listening={tool === 'select' && !line.locked} />}
      {marquee && (
        <Rect
          {...marquee}
          fill="rgba(14, 165, 233, 0.08)"
          stroke={ACCENT}
          strokeWidth={1}
          strokeScaleEnabled={false}
          listening={false}
        />
      )}
    </>
  )
}
