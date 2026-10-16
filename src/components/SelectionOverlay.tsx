import type Konva from 'konva'
import type { KonvaEventObject } from 'konva/lib/Node'
// A box as the Transformer measures it: on the Stage's container, in screen pixels, turned.
import type { Box as TransformerBox } from 'konva/lib/shapes/Transformer'
import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react'
import { Circle, Rect, Transformer } from 'react-konva'
import { applyTransform, invertTransform, type Box as CanvasBox } from '../lib/geometry/bounds'
import {
  absoluteTransform,
  bakeTransforms,
  isAxisAligned,
  normalizeRotation,
  snapAngle,
} from '../lib/geometry/transform'
import { beginSnap } from '../lib/snap/session'
import { snapResizeBox, snapThreshold, type Edge, type SnapTargets } from '../lib/snap/snap'
import { inkBox } from '../lib/snap/targets'
import { useEditorStore, zoomOf } from '../store/editorStore'
import type { NodeId, NodeOf, Transform, VectorNode } from '../types'
import { ACCENT, ANCHOR_SIZE, HANDLE_GRIP } from './overlayStyle'

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
// A text's height follows its lines, so it has no top and bottom handles.
const TEXT_ANCHORS = [...CORNER_ANCHORS, 'middle-left', 'middle-right']
const SIDE_ANCHORS = new Set(['middle-left', 'middle-right'])
const MIN_SIZE_PX = 2 // smallest box a resize may leave, in screen pixels

// Konva's matrix math leaves noise such as 0.9999999999999997 on axes nobody scaled.
const roundScale = (scale: number) => Math.round(scale * 1e6) / 1e6

// Screen pixels between the ink and the box, so a thin stroke's middle handles don't cover it
// and a press on the stroke moves it instead of stretching it.
const BOX_PADDING = ANCHOR_SIZE / 2 + 4

const store = () => useEditorStore.getState()

/** The box edges a Transformer handle moves, from its name, such as 'top-left'. */
function edgesOf(anchor: string): Edge[] {
  const edges: Edge[] = []
  if (anchor.includes('left')) edges.push('left')
  if (anchor.includes('right')) edges.push('right')
  if (anchor.startsWith('top')) edges.push('top')
  if (anchor.startsWith('bottom')) edges.push('bottom')
  return edges
}

/** Whether an angle in radians is a turn other than none. */
const isTurned = (radians: number) =>
  Math.abs(Math.atan2(Math.sin(radians), Math.cos(radians))) > 1e-6

interface ResizeSnap {
  targets: SnapTargets
  // How far the selection's ink reaches past the Transformer's box on each side, in canvas units:
  // the box leaves outlines out, while snapping goes by what shows. Measured on the first move.
  pads: CanvasBox | null
}

/** Modifier keys as the latest pointer or key event had them; boundBoxFunc gets no event. */
function useModifierKeys() {
  const keys = useRef({ shift: false, alt: false, mod: false })
  useEffect(() => {
    const track = (e: PointerEvent | KeyboardEvent) => {
      keys.current = { shift: e.shiftKey, alt: e.altKey, mod: e.ctrlKey || e.metaKey }
    }
    const events = ['pointerdown', 'pointermove', 'keydown', 'keyup'] as const
    // Capturing on the window, so the keys are known before Konva's own handlers resize.
    for (const type of events) window.addEventListener(type, track, true)
    return () => {
      for (const type of events) window.removeEventListener(type, track, true)
    }
  }, [])
  return keys
}

/** Moves one end of a line to where its handle was dragged; Shift snaps the line to 45°. */
function dragLineEnd(id: NodeId, end: 0 | 1, e: KonvaEventObject<DragEvent>) {
  const { nodes } = store().doc
  const line = nodes[id]
  if (line?.type !== 'line') return
  const t = absoluteTransform(nodes, id)
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
function LineEnds({
  line,
  transform,
  listening,
}: {
  line: NodeOf<'line'>
  transform: Transform // the line's on the canvas, through its groups
  listening: boolean
}) {
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
  const ends = [applyTransform(transform, x1, y1), applyTransform(transform, x2, y2)]
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
      hitStrokeWidth={HANDLE_GRIP}
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
  const resizeSnap = useRef<ResizeSnap | null>(null)
  const keys = useModifierKeys()
  const doc = useEditorStore((s) => s.doc)
  const selection = useEditorStore((s) => s.selection)
  const tool = useEditorStore((s) => s.tool)
  const marquee = useEditorStore((s) => s.marquee)
  const editing = useEditorStore((s) => s.editingText !== null)
  // Handles only work with the select tool; panning with Space keeps them in view. A text being
  // edited shows the editor instead.
  const shown = (tool === 'select' || tool === 'hand') && !editing
  const single = selection.length === 1 ? doc.nodes[selection[0]] : undefined
  const line = shown && single?.type === 'line' ? single : null
  const text = single?.type === 'text'

  // Konva's multi-node box is axis-aligned, so stretching one axis would skew rotated nodes, and
  // a group's scale would skew turned children. A single text keeps its ratio at the corners.
  const freeAspect =
    selection.length <= 1
      ? !text &&
        (single?.type !== 'group' || single.childIds.every((id) => isAxisAligned(doc.nodes, id)))
      : selection.every((id) => isAxisAligned(doc.nodes, id))
  const anchors = text ? TEXT_ANCHORS : freeAspect ? ALL_ANCHORS : CORNER_ANCHORS

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

  // A single text's side handles change its width as they move, so it wraps live instead of
  // stretching; the width is in Konva until transformend.
  const handleTransform = () => {
    const transformer = transformerRef.current
    const [shape] = transformer?.nodes() ?? []
    if (!transformer || !text || !shape || !SIDE_ANCHORS.has(transformer.getActiveAnchor() ?? '')) {
      return
    }
    shape.setAttrs({ width: shape.width() * shape.scaleX(), scaleX: 1 })
  }

  // A resize snaps the edges its handle moves to the page and other objects; a turn doesn't snap.
  const handleTransformStart = () => {
    const anchor = transformerRef.current?.getActiveAnchor() ?? ''
    const targets = anchor.startsWith('rotater') ? null : beginSnap(store().selection)
    resizeSnap.current = targets && { targets, pads: null }
  }

  /**
   * The Transformer's next box with its moving edges snapped, unless Ctrl or Cmd is held. Only an
   * unturned box snaps: a turned one's edges aren't the axis-aligned lines snapping goes by.
   */
  const snapBox = (oldBox: TransformerBox, newBox: TransformerBox): TransformerBox => {
    const snap = resizeSnap.current
    const anchor = transformerRef.current?.getActiveAnchor() ?? ''
    const state = store()
    const zoom = zoomOf(state)
    if (
      !snap ||
      keys.current.mod ||
      zoom <= 0 ||
      isTurned(newBox.rotation) ||
      newBox.width <= 0 ||
      newBox.height <= 0
    ) {
      state.setGuides([])
      return newBox
    }
    const { x: viewX, y: viewY } = state.view
    const toCanvas = (b: TransformerBox): CanvasBox => ({
      minX: (b.x - viewX) / zoom,
      minY: (b.y - viewY) / zoom,
      maxX: (b.x + b.width - viewX) / zoom,
      maxY: (b.y + b.height - viewY) / zoom,
    })
    if (!snap.pads) {
      const start = toCanvas(oldBox)
      const ink = inkBox(state.doc, state.selection) ?? start
      snap.pads = {
        minX: start.minX - ink.minX,
        minY: start.minY - ink.minY,
        maxX: ink.maxX - start.maxX,
        maxY: ink.maxY - start.maxY,
      }
    }
    const pads = snap.pads
    const box = toCanvas(newBox)
    const { box: inked, guides } = snapResizeBox(
      {
        minX: box.minX - pads.minX,
        minY: box.minY - pads.minY,
        maxX: box.maxX + pads.maxX,
        maxY: box.maxY + pads.maxY,
      },
      edgesOf(anchor),
      snap.targets,
      snapThreshold(zoom),
      // As Konva decides: a corner keeps the ratio when the Transformer does or Shift is held,
      // and Alt resizes about the center.
      { keepRatio: !freeAspect || keys.current.shift, centered: keys.current.alt },
    )
    state.setGuides(guides)
    const minX = inked.minX + pads.minX
    const minY = inked.minY + pads.minY
    return {
      x: minX * zoom + viewX,
      y: minY * zoom + viewY,
      width: (inked.maxX - pads.maxX - minX) * zoom,
      height: (inked.maxY - pads.maxY - minY) * zoom,
      rotation: newBox.rotation,
    }
  }

  const tooSmall = (box: TransformerBox) =>
    Math.abs(box.width) < MIN_SIZE_PX || Math.abs(box.height) < MIN_SIZE_PX

  const handleTransformEnd = () => {
    resizeSnap.current = null
    store().setGuides([])
    const transformer = transformerRef.current
    if (!transformer) return
    const { doc, updateNodes } = useEditorStore.getState()
    const patch: Record<NodeId, Partial<VectorNode>> = {}
    for (const shape of transformer.nodes()) {
      const node = doc.nodes[shape.id()]
      if (!node) continue
      // A text's width may already have taken some of the scale, live.
      const widthScale = node.type === 'text' && node.width > 0 ? shape.width() / node.width : 1
      const changes = bakeTransforms(doc.nodes, node, {
        x: shape.x(),
        y: shape.y(),
        rotation: normalizeRotation(shape.rotation()),
        scaleX: roundScale(shape.scaleX() * widthScale),
        scaleY: roundScale(shape.scaleY()),
      })
      const t = changes[node.id]?.transform ?? node.transform
      // React only sets props that differ from its last render, so Konva must already hold the
      // model's values: a baked scale goes back to 1, and any skew is dropped.
      shape.setAttrs({ ...t, skewX: 0, skewY: 0 })
      Object.assign(patch, changes)
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
        enabledAnchors={anchors}
        padding={BOX_PADDING}
        anchorSize={ANCHOR_SIZE}
        anchorCornerRadius={2}
        anchorStroke={ACCENT}
        borderStroke={ACCENT}
        boundBoxFunc={(oldBox, newBox) => {
          if (tooSmall(newBox)) return oldBox
          const snapped = snapBox(oldBox, newBox)
          return tooSmall(snapped) ? oldBox : snapped
        }}
        onTransformStart={handleTransformStart}
        onTransform={handleTransform}
        onTransformEnd={handleTransformEnd}
      />
      {line && (
        <LineEnds
          key={line.id}
          line={line}
          transform={absoluteTransform(doc.nodes, line.id)}
          listening={tool === 'select'}
        />
      )}
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
