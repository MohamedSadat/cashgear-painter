import type { KonvaEventObject } from 'konva/lib/Node'
import { useEffect, useRef } from 'react'
import { Circle, Group, Line } from 'react-konva'
import { withPatch } from '../lib/align/numeric'
import { applyTransform, fillBox, invertTransform } from '../lib/geometry/bounds'
import { absoluteTransform, snapAngle } from '../lib/geometry/transform'
import {
  isGradient,
  placeGradient,
  radiusUnit,
  toBoxUnits,
  type Gradient,
  type PaintBox,
  type PlacedGradient,
  type Xy,
} from '../lib/paint/paint'
import { pageBox } from '../lib/paint/toKonva'
import { currentPageOf, useEditorStore, zoomOf } from '../store/editorStore'
import { IDENTITY_TRANSFORM, type NodeId, type Transform } from '../types'
import { ACCENT, ANCHOR_SIZE, HANDLE_GRIP } from './overlayStyle'

const store = () => useEditorStore.getState()

// The smallest radius a drag leaves, in box units: a radius of 0 would paint only the last stop.
const MIN_RADIUS = 0.001

/** What the handles edit: a node's fill, or the current page's background with nothing selected. */
type Target = { kind: 'node'; id: NodeId } | { kind: 'page'; id: string }

/** The target's gradient, its fill box and the transform from that box to the canvas, now. */
interface Placement {
  paint: Gradient
  box: PaintBox
  transform: Transform
}

/** Reads the target from the store as it is now, for a drag in progress. */
function placementOf(target: Target): Placement | null {
  const state = store()
  if (target.kind === 'page') {
    const page = state.doc.pages.find((p) => p.id === target.id)
    if (!page || !isGradient(page.background)) return null
    return { paint: page.background, box: pageBox(page), transform: IDENTITY_TRANSFORM }
  }
  const node = state.doc.nodes[target.id]
  const box = node && fillBox(node)
  if (!node || !box || !isGradient(node.style.fill)) return null
  return {
    paint: node.style.fill,
    box,
    transform: absoluteTransform(state.doc.nodes, target.id),
  }
}

/** Gives the target a new gradient; inside the drag's gesture, so the drag is one undo step. */
function applyPaint(target: Target, paint: Gradient) {
  const state = store()
  if (target.kind === 'page') {
    state.updatePage(target.id, { background: paint })
    return
  }
  state.setFill({ [target.id]: paint })
}

type HandleName = 'start' | 'end' | 'center' | 'radius'

/**
 * Moves one gradient handle to where it was dragged, given in canvas units. Linear ends move
 * freely, and Shift turns the gradient in 45° steps of the object's own frame; the center moves
 * the radial gradient, and the radius handle sets its radius by its distance from the center.
 * The dragged shape is put where the model now has it.
 */
function dragHandle(target: Target, handle: HandleName, e: KonvaEventObject<DragEvent>) {
  const placement = placementOf(target)
  if (!placement) return
  const { paint, box, transform: t } = placement
  const placed = placeGradient(paint, box)
  let local = invertTransform(t, e.target.x(), e.target.y())
  let next: Gradient | null = null
  if (paint.kind === 'linear') {
    if (handle !== 'start' && handle !== 'end') return
    if (e.evt.shiftKey && placed?.kind === 'linear') {
      local = snapAngle(handle === 'start' ? placed.end : placed.start, local)
    }
    next = { ...paint, [handle]: toBoxUnits(box, local) }
  } else if (handle === 'center') {
    next = { ...paint, center: toBoxUnits(box, local) }
  } else if (handle === 'radius' && placed?.kind === 'radial') {
    const distance = Math.hypot(local[0] - placed.center[0], local[1] - placed.center[1])
    next = { ...paint, radius: Math.max(MIN_RADIUS, distance / radiusUnit(box)) }
  }
  if (!next) return
  applyPaint(target, next)
  const after = placeGradient(next, box)
  if (after) {
    const [x, y] = applyTransform(t, ...handlePoint(after, handle))
    e.target.position({ x, y })
  }
}

/** Where a handle sits in the box's coordinates; the radius handle is right of the center. */
function handlePoint(placed: PlacedGradient, handle: HandleName): Xy {
  if (placed.kind === 'linear') return handle === 'start' ? placed.start : placed.end
  const [cx, cy] = placed.center
  return handle === 'radius' ? [cx + placed.radius, cy] : placed.center
}

interface HandlesProps {
  target: Target
  placement: Placement
  zoom: number
}

// Guides are a white line under a blue one, so they show on any color; they are never picked.
const GUIDE_UNDER = {
  stroke: '#ffffff',
  strokeWidth: 3,
  strokeScaleEnabled: false,
  listening: false,
}
const GUIDE = { stroke: ACCENT, strokeWidth: 1, strokeScaleEnabled: false, listening: false }

/**
 * A gradient's handles: two ends on a line for a linear gradient, a center and a radius handle
 * on a circle for a radial one. Ends show the color of the stop they hold. Dragging a handle is
 * one undo step.
 */
function GradientHandles({ target, placement, zoom }: HandlesProps) {
  const dragging = useRef(false)
  // A drag cut short by the handles going away (an undo, a selection change) still closes its
  // undo step.
  useEffect(
    () => () => {
      if (dragging.current) store().endGesture()
    },
    [],
  )
  const { paint, box, transform: t } = placement
  const placed = placeGradient(paint, box)
  if (!placed) return null
  const toCanvas = (p: Xy) => applyTransform(t, p[0], p[1])

  const knob = (handle: HandleName, color: string) => {
    const [x, y] = toCanvas(handlePoint(placed, handle))
    return (
      <Circle
        key={handle}
        name={`gradient-${handle}`}
        x={x}
        y={y}
        radius={ANCHOR_SIZE / 2 / zoom}
        fill={color}
        stroke={ACCENT}
        strokeWidth={2}
        strokeScaleEnabled={false}
        hitStrokeWidth={HANDLE_GRIP}
        draggable
        onDragStart={() => {
          dragging.current = true
          store().beginGesture()
        }}
        onDragMove={(e) => dragHandle(target, handle, e)}
        onDragEnd={() => {
          dragging.current = false
          store().endGesture()
        }}
      />
    )
  }

  const first = placed.stops[0].color
  const last = placed.stops[placed.stops.length - 1].color
  if (placed.kind === 'linear') {
    const [x1, y1] = toCanvas(placed.start)
    const [x2, y2] = toCanvas(placed.end)
    return (
      <>
        <Line points={[x1, y1, x2, y2]} {...GUIDE_UNDER} />
        <Line points={[x1, y1, x2, y2]} {...GUIDE} />
        {knob('start', first)}
        {knob('end', last)}
      </>
    )
  }
  const [cx, cy] = placed.center
  const [rx, ry] = toCanvas([cx + placed.radius, cy])
  const [ox, oy] = toCanvas(placed.center)
  return (
    <>
      {/* The circle the gradient ends on, in the object's own frame, so it turns and stretches. */}
      <Group {...t} listening={false}>
        <Circle x={cx} y={cy} radius={placed.radius} {...GUIDE_UNDER} />
        <Circle x={cx} y={cy} radius={placed.radius} {...GUIDE} />
      </Group>
      <Line points={[ox, oy, rx, ry]} {...GUIDE_UNDER} />
      <Line points={[ox, oy, rx, ry]} {...GUIDE} />
      {knob('center', first)}
      {knob('radius', last)}
    </>
  )
}

/**
 * Handles for editing a gradient on the canvas, on the overlay layer at a constant screen size:
 * for the one selected object when its fill is a gradient, or for the page's background when
 * nothing is selected and it is one. They show with the select tool, and follow a Transformer
 * drag through its preview.
 */
export function GradientOverlay() {
  const tool = useEditorStore((s) => s.tool)
  const doc = useEditorStore((s) => s.doc)
  const selection = useEditorStore((s) => s.selection)
  const preview = useEditorStore((s) => s.transformPreview)
  const editing = useEditorStore((s) => s.editingText !== null)
  const page = useEditorStore(currentPageOf)
  const zoom = useEditorStore(zoomOf)
  if (tool !== 'select' || editing || zoom <= 0) return null

  let target: Target | null = null
  let placement: Placement | null = null
  if (selection.length === 1) {
    const nodes = preview ? withPatch(doc.nodes, preview) : doc.nodes
    const node = nodes[selection[0]]
    const box = node && fillBox(node)
    if (node && box && isGradient(node.style.fill)) {
      target = { kind: 'node', id: node.id }
      placement = { paint: node.style.fill, box, transform: absoluteTransform(nodes, node.id) }
    }
  } else if (selection.length === 0 && isGradient(page.background)) {
    target = { kind: 'page', id: page.id }
    placement = { paint: page.background, box: pageBox(page), transform: IDENTITY_TRANSFORM }
  }
  if (!target || !placement) return null
  return (
    <GradientHandles
      key={`${target.kind}-${target.id}`}
      target={target}
      placement={placement}
      zoom={zoom}
    />
  )
}
