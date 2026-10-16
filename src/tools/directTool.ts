import { applyTransform, invertTransform, outlineReach } from '../lib/geometry/bounds'
import { nearestOnPath } from '../lib/geometry/hitTest'
import {
  anchorWithKind,
  insertAnchor,
  withHandle,
  type AnchorKind,
  type HandleSide,
  type Xy,
} from '../lib/geometry/pathData'
import { absoluteTransform } from '../lib/geometry/transform'
import {
  isPickable,
  useEditorStore,
  zoomOf,
  type AnchorRef,
  type EditorState,
} from '../store/editorStore'
import type { Anchor, Contour, PathNode } from '../types'
import { doublePressDetector } from './selectTool'
import type { ToolController } from './types'

const store = () => useEditorStore.getState()

// Screen pixels from a path's outline where a double-click still adds an anchor.
const ADD_REACH_PX = 8
const NUDGE = 1
const BIG_NUDGE = 10 // with Shift

const ARROWS: Record<string, Xy> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
}

type DocState = Pick<EditorState, 'doc' | 'selection' | 'currentPageId'>

/**
 * The selected paths that show their anchors: the visible, unlocked ones, in or out of groups.
 * Each comes with its transform on the canvas, through its groups.
 */
export function editablePaths({ doc, selection, currentPageId }: DocState): PathNode[] {
  return selection.flatMap((id) => {
    const node = doc.nodes[id]
    if (node?.type !== 'path' || !isPickable(doc, id, currentPageId)) return []
    return node.parentId === null
      ? [node]
      : [{ ...node, transform: absoluteTransform(doc.nodes, id) }]
  })
}

/** The active anchor and its path, while the path is selected, visible, unlocked and has it. */
export function activeAnchorOf({
  doc,
  selection,
  currentPageId,
  activeAnchor,
}: DocState & Pick<EditorState, 'activeAnchor'>): {
  path: PathNode
  contour: number
  index: number
} | null {
  if (!activeAnchor || !selection.includes(activeAnchor.id)) return null
  const path = doc.nodes[activeAnchor.id]
  if (path?.type !== 'path' || !isPickable(doc, path.id, currentPageId)) return null
  const { contour, index } = activeAnchor
  if (index >= (path.contours[contour]?.anchors.length ?? 0)) return null
  return { path, contour, index }
}

/** The path's contours with one replaced by `change` of it. */
function withContour(path: PathNode, contour: number, change: (c: Contour) => Contour): Contour[] {
  return path.contours.map((c, i) => (i === contour ? change(c) : c))
}

/**
 * Replaces one anchor of a path; `mergeKey` folds quick repeats into one undo step. `change`
 * gets the path's transform on the canvas, for paths inside groups.
 */
function replaceAnchor(
  ref: AnchorRef,
  change: (anchor: Anchor, path: PathNode) => Anchor,
  mergeKey?: string,
) {
  const { doc } = store()
  const path = doc.nodes[ref.id]
  if (path?.type !== 'path' || path.locked) return
  const anchor = path.contours[ref.contour]?.anchors[ref.index]
  if (!anchor) return
  const placed = { ...path, transform: absoluteTransform(doc.nodes, path.id) }
  const contours = withContour(path, ref.contour, (c) => ({
    ...c,
    anchors: c.anchors.map((a, i) => (i === ref.index ? change(anchor, placed) : a)),
  }))
  store().updateNodes({ [ref.id]: { contours } }, mergeKey)
}

/** Moves an anchor and its handles to a canvas point. */
export function moveAnchorTo(ref: AnchorRef, [x, y]: Xy, mergeKey?: string): void {
  replaceAnchor(
    ref,
    (anchor, path) => {
      const [lx, ly] = invertTransform(path.transform, x, y)
      return { ...anchor, x: lx, y: ly }
    },
    mergeKey,
  )
}

/** Moves one handle to a canvas point; the other follows the anchor's kind unless `breakTwin`. */
export function moveHandleTo(ref: AnchorRef, side: HandleSide, [x, y]: Xy, breakTwin: boolean) {
  replaceAnchor(ref, (anchor, path) => {
    const [lx, ly] = invertTransform(path.transform, x, y)
    return withHandle(anchor, side, [lx - anchor.x, ly - anchor.y], breakTwin)
  })
}

/** Makes the active anchor a corner, smooth or symmetric, as one undo step. */
export function setActiveAnchorKind(kind: AnchorKind): void {
  const active = activeAnchorOf(store())
  if (!active) return
  const { path, contour, index } = active
  const { anchors, closed } = path.contours[contour]
  replaceAnchor({ id: path.id, contour, index }, () => anchorWithKind(anchors, closed, index, kind))
}

/**
 * Deletes the active anchor, as one undo step. A contour left with fewer than 2 anchors goes too,
 * and so does a path left without contours.
 */
export function deleteActiveAnchor(): boolean {
  const active = activeAnchorOf(store())
  if (!active) return false
  const { path, contour, index } = active
  const anchors = path.contours[contour].anchors.filter((_, i) => i !== index)
  const contours =
    anchors.length < 2
      ? path.contours.filter((_, i) => i !== contour)
      : withContour(path, contour, (c) => ({ ...c, anchors }))
  if (contours.length === 0) store().deleteNodes([path.id])
  else store().updateNodes({ [path.id]: { contours } })
  store().setActiveAnchor(null)
  return true
}

/**
 * Adds an anchor where the path's outline passes within `reach` canvas units of a canvas point,
 * keeping the curve's shape, and makes it the active anchor. False when the outline is too far.
 */
export function addAnchorNear(path: PathNode, point: Xy, reach: number): boolean {
  const { nodes } = store().doc
  const near = nearestOnPath({ ...path, transform: absoluteTransform(nodes, path.id) }, point)
  if (!near || near.distance > reach) return false
  const contours = withContour(path, near.contour, (c) => ({
    ...c,
    anchors: insertAnchor(c.anchors, c.closed, near.segment, near.t),
  }))
  store().updateNodes({ [path.id]: { contours } })
  store().setActiveAnchor({ id: path.id, contour: near.contour, index: near.segment + 1 })
  return true
}

const isDoublePress = doublePressDetector()

/**
 * Direct select: click a path to show its anchors and handles (PathEditOverlay drags them).
 * It picks the object under the pointer itself, even inside a group. Double-click a segment to
 * add an anchor; Delete removes the active one, and arrow keys nudge it. Without an active
 * anchor, Delete and the arrows act on the selected objects.
 */
export const directTool: ToolController = {
  cursor: 'default',
  picksNodes: true,

  onDown(e) {
    const double = isDoublePress(e)
    const { doc, selection } = store()
    const target = e.target !== null && e.target in doc.nodes ? e.target : null
    if (target === null) {
      if (!e.shift) store().select([])
      return
    }
    if (e.shift) store().select([target], 'toggle')
    else if (!selection.includes(target)) store().select([target])
    store().setActiveAnchor(null)
    const node = doc.nodes[target]
    if (double && node.type === 'path' && !node.locked && store().selection.includes(target)) {
      const reach = Math.max(outlineReach(node), ADD_REACH_PX / zoomOf(store()))
      addAnchorNear(node, e.point, reach)
    }
  },

  onMove() {},

  onUp() {},

  onKey(e) {
    const { selection, activeAnchor } = store()
    if (e.key === 'Escape') {
      if (activeAnchor) store().setActiveAnchor(null)
      else if (selection.length > 0) store().select([])
      else return false
      return true
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return false

    const active = activeAnchorOf(store())
    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (deleteActiveAnchor()) return true
      if (selection.length === 0) return false
      store().deleteNodes(selection)
      return true
    }
    const arrow = ARROWS[e.key]
    if (!arrow || (!active && selection.length === 0)) return false
    const step = e.shiftKey ? BIG_NUDGE : NUDGE
    const [dx, dy] = [arrow[0] * step, arrow[1] * step]
    if (!active) store().nudge(selection, dx, dy)
    else {
      // Nudged on screen, so a turned path's anchor moves the way the arrow points.
      const { path, contour, index } = active
      const t = absoluteTransform(store().doc.nodes, path.id)
      const anchor = path.contours[contour].anchors[index]
      const [x, y] = applyTransform(t, anchor.x, anchor.y)
      moveAnchorTo({ id: path.id, contour, index }, [x + dx, y + dy], 'nudge')
    }
    return true
  },
}
