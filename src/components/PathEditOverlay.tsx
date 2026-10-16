import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Circle, Line, Path, Rect } from 'react-konva'
import { applyTransform } from '../lib/geometry/bounds'
import { cachedPathData, handleOf, type HandleSide, type Xy } from '../lib/geometry/pathData'
import { useEditorStore, zoomOf } from '../store/editorStore'
import { activeAnchorOf, editablePaths, moveAnchorTo, moveHandleTo } from '../tools/directTool'
import { CLOSE_RADIUS } from '../tools/penTool'
import type { Contour, PathNode } from '../types'
import { ACCENT, ANCHOR_SIZE, HANDLE_GRIP } from './overlayStyle'

const store = () => useEditorStore.getState()

const HANDLE_RADIUS = ANCHOR_SIZE * 0.4 // screen pixels, like every size here
const PEN_ANCHOR_SIZE = ANCHOR_SIZE * 0.75
const SIDES: HandleSide[] = ['in', 'out']

// Outlines, handle arms and the pen's rubber band: 1 screen pixel at any zoom, never picked.
const THIN = { stroke: ACCENT, strokeWidth: 1, strokeScaleEnabled: false, listening: false }
const KNOB = { stroke: ACCENT, strokeWidth: 1, strokeScaleEnabled: false }

const isZero = ([x, y]: Xy) => x === 0 && y === 0

/** Whether the handle shapes a segment: an open contour's first in and last out handles don't. */
function shapesSegment(contour: Contour, index: number, side: HandleSide): boolean {
  if (contour.closed) return true
  return side === 'in' ? index > 0 : index < contour.anchors.length - 1
}

interface PathHandlesProps {
  path: PathNode
  active: { contour: number; index: number } | null
  zoom: number
}

/**
 * A selected path's outline, anchors and handles for direct select. Pressing an anchor or one of
 * its handles makes it the active anchor; dragging one is one undo step, and Alt-dragging a handle
 * breaks its link to the other one.
 */
function PathHandles({ path, active, zoom }: PathHandlesProps) {
  // The handle being dragged stays even while it has no length, so the drag goes on.
  const [dragging, setDragging] = useState<string | null>(null)
  const inGesture = useRef(false)
  // A drag cut short by the handles going away (a shortcut that changes the selection) still
  // closes its undo step.
  useEffect(
    () => () => {
      if (inGesture.current) store().endGesture()
    },
    [],
  )
  const startDrag = (key: string) => {
    inGesture.current = true
    setDragging(key)
    store().beginGesture()
  }
  const endDrag = () => {
    inGesture.current = false
    setDragging(null)
    store().endGesture()
  }

  const { transform: t } = path
  const listening = !path.locked
  const arms: ReactNode[] = []
  const knobs: ReactNode[] = []
  const anchors: ReactNode[] = []
  const size = ANCHOR_SIZE / zoom
  // Named by contour and index, such as anchor-0-2 and handle-out-0-2.
  path.contours.forEach((contour, c) =>
    contour.anchors.forEach((anchor, index) => {
      const ref = { id: path.id, contour: c, index }
      const at = applyTransform(t, anchor.x, anchor.y)
      const isActive = active?.contour === c && active.index === index
      for (const side of SIDES) {
        const key = `${side}-${c}-${index}`
        const handle = handleOf(anchor, side)
        if ((isZero(handle) || !shapesSegment(contour, index, side)) && dragging !== key) continue
        const [hx, hy] = applyTransform(t, anchor.x + handle[0], anchor.y + handle[1])
        arms.push(<Line key={key} points={[at[0], at[1], hx, hy]} {...THIN} />)
        knobs.push(
          <Circle
            key={key}
            {...KNOB}
            name={`handle-${key}`}
            x={hx}
            y={hy}
            radius={HANDLE_RADIUS / zoom}
            fill="#ffffff"
            hitStrokeWidth={HANDLE_GRIP}
            listening={listening}
            draggable
            onPointerDown={() => store().setActiveAnchor(ref)}
            onDragStart={() => startDrag(key)}
            onDragMove={(e) => moveHandleTo(ref, side, [e.target.x(), e.target.y()], e.evt.altKey)}
            onDragEnd={endDrag}
          />,
        )
      }
      anchors.push(
        <Rect
          key={`${c}-${index}`}
          {...KNOB}
          name={`anchor-${c}-${index}`}
          x={at[0]}
          y={at[1]}
          width={size}
          height={size}
          offsetX={size / 2}
          offsetY={size / 2}
          fill={isActive ? ACCENT : '#ffffff'}
          hitStrokeWidth={HANDLE_GRIP}
          listening={listening}
          draggable
          onPointerDown={() => store().setActiveAnchor(ref)}
          onDragStart={() => startDrag(`anchor-${c}-${index}`)}
          onDragMove={(e) => moveAnchorTo(ref, [e.target.x(), e.target.y()])}
          onDragEnd={endDrag}
        />,
      )
    }),
  )

  return (
    <>
      <Path data={cachedPathData(path)} {...t} {...THIN} />
      {arms}
      {knobs}
      {anchors}
    </>
  )
}

const xy = ([x, y]: Xy) => `${x} ${y}`

/**
 * The pen's path so far: its anchors, the handles of the newest one, and a rubber band from the
 * last anchor to the hovering pointer. Near the first anchor, the band and that anchor show that
 * a click closes the path.
 */
function PenPreview({ draft, hover, zoom }: { draft: PathNode; hover: Xy | null; zoom: number }) {
  const t = draft.transform
  const toCanvas = (x: number, y: number) => applyTransform(t, x, y)
  // The pen draws one contour.
  const anchors = draft.contours[0]?.anchors ?? []
  if (anchors.length === 0) return null
  const points = anchors.map((a) => toCanvas(a.x, a.y))
  const first = anchors[0]
  const last = anchors[anchors.length - 1]
  const lastAt = points[points.length - 1]
  const closing =
    hover !== null &&
    anchors.length >= 2 &&
    Math.hypot(hover[0] - points[0][0], hover[1] - points[0][1]) * zoom <= CLOSE_RADIUS

  let band: ReactNode = null
  if (hover) {
    const c1 = toCanvas(last.x + last.outX, last.y + last.outY)
    const [c2, end] = closing
      ? [toCanvas(first.x + first.inX, first.y + first.inY), points[0]]
      : [hover, hover]
    band = <Path data={`M ${xy(lastAt)} C ${xy(c1)} ${xy(c2)} ${xy(end)}`} {...THIN} />
  }
  const handles = SIDES.flatMap((side) => {
    const handle = handleOf(last, side)
    if (isZero(handle)) return []
    const [hx, hy] = toCanvas(last.x + handle[0], last.y + handle[1])
    return [
      <Line key={`arm-${side}`} points={[lastAt[0], lastAt[1], hx, hy]} {...THIN} />,
      <Circle
        key={`knob-${side}`}
        {...KNOB}
        x={hx}
        y={hy}
        radius={HANDLE_RADIUS / zoom}
        fill="#ffffff"
        listening={false}
      />,
    ]
  })
  const size = PEN_ANCHOR_SIZE / zoom
  return (
    <>
      {band}
      {handles}
      {points.map(([x, y], index) => (
        <Rect
          key={index}
          {...KNOB}
          name={`pen-anchor-${index}`}
          x={x}
          y={y}
          width={size}
          height={size}
          offsetX={size / 2}
          offsetY={size / 2}
          fill={index === 0 && closing ? ACCENT : '#ffffff'}
          listening={false}
        />
      ))}
    </>
  )
}

/**
 * Path editing on the overlay layer, at a constant screen size: the pen's path while it is drawn,
 * and the anchors and handles of selected paths with direct select.
 */
export function PathEditOverlay() {
  const tool = useEditorStore((s) => s.tool)
  const doc = useEditorStore((s) => s.doc)
  const selection = useEditorStore((s) => s.selection)
  const activeAnchor = useEditorStore((s) => s.activeAnchor)
  const draft = useEditorStore((s) => s.draft)
  const penHover = useEditorStore((s) => s.penHover)
  const zoom = useEditorStore(zoomOf)
  const currentPageId = useEditorStore((s) => s.currentPageId)

  if (tool === 'pen') {
    return draft?.type === 'path' ? <PenPreview draft={draft} hover={penHover} zoom={zoom} /> : null
  }
  if (tool !== 'direct') return null
  const active = activeAnchorOf({ doc, selection, currentPageId, activeAnchor })
  return editablePaths({ doc, selection, currentPageId }).map((path) => (
    <PathHandles
      key={path.id}
      path={path}
      active={active?.path.id === path.id ? active : null}
      zoom={zoom}
    />
  ))
}
