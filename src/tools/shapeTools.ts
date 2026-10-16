import { snapAngle } from '../lib/geometry/transform'
import { beginSnap, currentThreshold } from '../lib/snap/session'
import { pointBox, snapMove, toSnapBox, type SnapTargets } from '../lib/snap/snap'
import {
  DEFAULT_SHAPE_STYLE,
  createEllipseNode,
  createLineNode,
  createRectNode,
  newNodeId,
  useEditorStore,
  zoomOf,
  type Rect,
} from '../store/editorStore'
import type { NodeId, ShapeNode, Style } from '../types'
import type { ToolController, ToolEvent } from './types'

const store = () => useEditorStore.getState()

type Xy = [number, number]

// Screen pixels the pointer must travel for a drag to draw; a click draws nothing.
const DRAW_SLOP = 3
// A drawn rectangle or ellipse is at least this many canvas units on each side, so the
// Transformer always has a box to scale.
const MIN_SIDE = 1

/** The style a new line gets: the shape style's outline, which a line can't do without. */
export function lineStyleOf(style: Style): Style {
  return { ...style, fill: null, stroke: style.stroke ?? DEFAULT_SHAPE_STYLE.stroke }
}

/**
 * The box a drag from `start` to `end` spans. `square` makes both sides as long as the longer one,
 * toward the pointer; `fromCenter` centers the box on `start`. Sides are at least `minSide`.
 */
export function dragBox(
  start: Xy,
  end: Xy,
  { square = false, fromCenter = false }: { square?: boolean; fromCenter?: boolean },
  minSide = 0,
): Rect {
  let dx = end[0] - start[0]
  let dy = end[1] - start[1]
  if (square) {
    const side = Math.max(Math.abs(dx), Math.abs(dy))
    dx = dx < 0 ? -side : side
    dy = dy < 0 ? -side : side
  }
  const scale = fromCenter ? 2 : 1
  const width = Math.max(minSide, Math.abs(dx) * scale)
  const height = Math.max(minSide, Math.abs(dy) * scale)
  const x = fromCenter ? start[0] - width / 2 : dx < 0 ? start[0] - width : start[0]
  const y = fromCenter ? start[1] - height / 2 : dy < 0 ? start[1] - height : start[1]
  return { x, y, width, height }
}

/** Builds the shape a drag from `start` to the event describes, under a fixed id and style. */
type Build = (start: Xy, e: ToolEvent, id: NodeId, style: Style, minSide: number) => ShapeNode

/**
 * The event with its point on the nearest target line within reach, and the guides that show it.
 * Ctrl or Cmd draws without snapping; so does `skip`, for a line Shift turns to 45°.
 */
function snapEvent(e: ToolEvent, targets: SnapTargets | null, skip: boolean): ToolEvent {
  if (!targets || e.mod || skip) {
    store().setGuides([])
    return e
  }
  const snap = snapMove(toSnapBox(pointBox(...e.point)), targets, currentThreshold())
  store().setGuides(snap.guides)
  return { ...e, point: [e.point[0] + snap.dx, e.point[1] + snap.dy] }
}

/**
 * Drag to draw: the shape grows as a draft, and on release it becomes a node, one undo step. The
 * dragged corner (a line's end) snaps to the page and other objects. The new shape is selected
 * and the select tool takes over, so its handles and its style in the properties panel are right
 * there.
 */
function shapeTool(
  build: Build,
  {
    styleOf = (s) => s,
    angleSnaps = false,
  }: { styleOf?(style: Style): Style; angleSnaps?: boolean } = {},
): ToolController {
  let drawing: { start: Xy; id: NodeId; style: Style; targets: SnapTargets | null } | null = null
  const snapped = (e: ToolEvent) => snapEvent(e, drawing?.targets ?? null, angleSnaps && e.shift)

  return {
    cursor: 'crosshair',

    onDown(e) {
      drawing = {
        start: e.point,
        id: newNodeId(),
        style: styleOf(store().shapeStyle),
        targets: beginSnap([]),
      }
      store().setDraft(build(e.point, e, drawing.id, drawing.style, 0))
    },

    onMove(e) {
      if (!drawing) return
      store().setDraft(build(drawing.start, snapped(e), drawing.id, drawing.style, 0))
    },

    onUp(e) {
      const finished = drawing
      if (!finished) return
      const end = snapped(e)
      drawing = null
      store().setGuides([])
      store().setDraft(null)
      const { start } = finished
      const travel = Math.hypot(e.point[0] - start[0], e.point[1] - start[1]) * zoomOf(store())
      if (travel < DRAW_SLOP) return
      const node = build(start, end, finished.id, finished.style, MIN_SIDE)
      store().addNodes([node])
      store().select([node.id])
      store().setTool('select')
    },

    onCancel() {
      drawing = null
      store().setGuides([])
      store().setDraft(null)
    },
  }
}

const boxOf = (start: Xy, e: ToolEvent, minSide: number) =>
  dragBox(start, e.point, { square: e.shift, fromCenter: e.alt }, minSide)

/** Rectangle: drag to draw; Shift makes a square, Alt draws from the center. */
export const rectTool = shapeTool((start, e, id, style, minSide) =>
  createRectNode(boxOf(start, e, minSide), style, id),
)

/** Ellipse: drag to draw; Shift makes a circle, Alt draws from the center. */
export const ellipseTool = shapeTool((start, e, id, style, minSide) =>
  createEllipseNode(boxOf(start, e, minSide), style, id),
)

/** Line: drag to draw; Shift snaps it to 45°. Arrowheads are set in the properties panel. */
export const lineTool = shapeTool(
  (start, e, id, style) =>
    createLineNode(start, e.shift ? snapAngle(start, e.point) : e.point, style, id),
  { styleOf: lineStyleOf, angleSnaps: true },
)
