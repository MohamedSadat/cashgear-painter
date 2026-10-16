import { canvasBounds, nodeBounds, unionBoxes, type Box } from '../lib/geometry/bounds'
import { deltaInParent } from '../lib/geometry/transform'
import { beginSnap, currentThreshold } from '../lib/snap/session'
import { shiftBox, snapMove, toSnapBox, type SnapTargets } from '../lib/snap/snap'
import { inkBox } from '../lib/snap/targets'
import { currentPageOf, outermost, useEditorStore, zoomOf, type Rect } from '../store/editorStore'
import type { Doc, NodeId, Transform, VectorNode } from '../types'
import { startTextEdit } from './textTool'
import type { ToolController, ToolEvent } from './types'

const store = () => useEditorStore.getState()

// Screen pixels a press may wander before it becomes a drag.
const DRAG_SLOP = 3
// A second press this soon and this close (in screen pixels) is a double-click or double-tap.
const DOUBLE_MS = 400
const DOUBLE_SLOP = 6
const TOUCH_DOUBLE_SLOP = 24

/**
 * A detector that tells whether each press is the second of a double-click or double-tap. Presses
 * are timed by their events, so a quick double-click still counts when a busy main thread handles
 * the second press late.
 */
export function doublePressDetector(): (e: ToolEvent) => boolean {
  let last: { at: number; point: [number, number] } | null = null
  return (e) => {
    const slop = e.pointerType === 'touch' ? TOUCH_DOUBLE_SLOP : DOUBLE_SLOP
    const travel = last ? Math.hypot(e.point[0] - last.point[0], e.point[1] - last.point[1]) : 0
    const double =
      last !== null && e.timeStamp - last.at < DOUBLE_MS && travel * zoomOf(store()) <= slop
    // A third press starts over, so a triple-click is not two doubles.
    last = double ? null : { at: e.timeStamp, point: e.point }
    return double
  }
}

const isDoublePress = doublePressDetector()
const NUDGE = 1
const BIG_NUDGE = 10 // with Shift

const ARROWS: Record<string, [number, number]> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
}

type Xy = [number, number]

type Drag =
  // Down, but not yet far enough to be a drag; `target` is the node under the pointer at the
  // level the selection is at.
  | {
      kind: 'press'
      start: Xy
      target: NodeId | null
      shift: boolean
      wasSelected: boolean
      inSelection: boolean // on empty canvas, but inside the selection's box
    }
  // `box` is the moved nodes' box when the drag began, and `targets` what it snaps to; null when
  // snapping is off.
  | {
      kind: 'move'
      start: Xy
      origins: Map<NodeId, Transform>
      box: Box | null
      targets: SnapTargets | null
    }
  | { kind: 'marquee'; start: Xy; base: NodeId[] }
  // The second press of a double-click on a text: its editor opens on release, which phones
  // accept as a gesture that may raise the keyboard.
  | { kind: 'edit'; id: NodeId }

let drag: Drag | null = null

/** The top-level node that `id` belongs to: clicking inside a group picks the group. */
export function topLevelId(doc: Doc, id: NodeId): NodeId | null {
  let node = doc.nodes[id]
  while (node && node.parentId !== null) node = doc.nodes[node.parentId]
  return node?.id ?? null
}

/** The group the selection is inside, when every selected node has that same parent. */
export function enteredGroup(doc: Doc, selection: NodeId[]): NodeId | null {
  const parents = new Set(selection.map((id) => doc.nodes[id]?.parentId ?? null))
  return parents.size === 1 ? [...parents][0] : null
}

/** The node `id` belongs to that sits right inside `parentId`; null when it isn't inside it. */
export function childWithin(doc: Doc, id: NodeId, parentId: NodeId | null): NodeId | null {
  let node: VectorNode | undefined = doc.nodes[id]
  while (node && node.parentId !== parentId) {
    node = node.parentId === null ? undefined : doc.nodes[node.parentId]
  }
  return node?.id ?? null
}

/**
 * What a click on the shape `hit` picks: at the top level the outermost group it is in, and
 * once a group has been entered (the selection is inside it) its child that holds the shape.
 */
export function pickTarget(doc: Doc, hit: NodeId, selection: NodeId[]): NodeId | null {
  const entered = enteredGroup(doc, selection)
  return (entered !== null && childWithin(doc, hit, entered)) || topLevelId(doc, hit)
}

/** The box on the canvas around the nodes' bounds; null when none of them has bounds. */
export function unionBounds(doc: Doc, ids: NodeId[]): Box | null {
  return unionBoxes(ids.map((id) => canvasBounds(doc.nodes, id)))
}

/** The visible, unlocked top-level nodes of a page whose bounds lie fully inside the rectangle. */
export function nodesInRect(doc: Doc, rootIds: NodeId[], rect: Rect): NodeId[] {
  return rootIds.filter((id) => {
    const node = doc.nodes[id]
    if (!node || node.hidden || node.locked) return false
    const box = nodeBounds(node, doc.nodes)
    return (
      box !== null &&
      box.minX >= rect.x &&
      box.minY >= rect.y &&
      box.maxX <= rect.x + rect.width &&
      box.maxY <= rect.y + rect.height
    )
  })
}

function rectBetween(a: Xy, b: Xy): Rect {
  return {
    x: Math.min(a[0], b[0]),
    y: Math.min(a[1], b[1]),
    width: Math.abs(a[0] - b[0]),
    height: Math.abs(a[1] - b[1]),
  }
}

const boxContains = (box: Box, [x, y]: Xy) =>
  x >= box.minX && x <= box.maxX && y >= box.minY && y <= box.maxY

/**
 * Starts moving the selected nodes, as one undo step; a group carries its children. The targets
 * they snap to are collected once, here.
 */
function startMove(start: Xy): Drag {
  const { doc, selection } = store()
  const origins = new Map<NodeId, Transform>()
  for (const id of outermost(doc, selection)) {
    const node = doc.nodes[id]
    if (!node.locked) origins.set(id, node.transform)
  }
  const box = inkBox(doc, [...origins.keys()])
  const targets = box ? beginSnap(selection) : null
  store().beginGesture()
  return { kind: 'move', start, origins, box, targets }
}

/**
 * A double-click goes one level deeper: into a group, selecting its child under the pointer;
 * from a path to direct select; into a text's editor. True when it did any of these.
 */
function openTarget(doc: Doc, target: NodeId, hit: NodeId): boolean {
  const node = doc.nodes[target]
  if (node.type === 'group') {
    const child = childWithin(doc, hit, target)
    if (child === null) return false
    store().select([child])
    return true
  }
  if (node.type === 'path') {
    store().select([target])
    store().setTool('direct')
    return true
  }
  if (node.type === 'text') {
    drag = { kind: 'edit', id: target }
    return true
  }
  return false
}

/** Ungroups every selected group as one undo step. */
export function ungroupSelection(): void {
  const { doc, selection } = store()
  const groups = selection.filter((id) => doc.nodes[id]?.type === 'group')
  if (groups.length === 0) return
  store().beginGesture()
  for (const id of groups) store().ungroup(id)
  store().endGesture()
}

/**
 * Click selects and Shift-click adds (or, on a selected node, removes). Dragging a node or the
 * inside of the selection moves the selection; dragging empty canvas draws a marquee that selects
 * what lies fully inside it. Resize and rotate belong to the Transformer in SelectionOverlay.
 * A click picks a whole group; a double-click enters it and selects the child under the pointer,
 * and clicks then pick within it until one lands outside. Double-clicking a path switches to
 * direct select to edit its anchors, and double-clicking a text edits it.
 */
export const selectTool: ToolController = {
  cursor: 'default',
  picksNodes: true,

  onDown(e) {
    const { doc, selection } = store()
    const target = e.target === null ? null : pickTarget(doc, e.target, selection)
    if (isDoublePress(e) && target !== null && openTarget(doc, target, e.target!)) return
    const wasSelected = target !== null && selection.includes(target)
    if (target !== null && !wasSelected) store().select([target], e.shift ? 'add' : 'replace')
    const box = target === null && !e.shift ? unionBounds(doc, selection) : null
    drag = {
      kind: 'press',
      start: e.point,
      target,
      shift: e.shift,
      wasSelected,
      inSelection: box !== null && boxContains(box, e.point),
    }
  },

  onMove(e) {
    if (!drag || drag.kind === 'edit') return
    if (drag.kind === 'press') {
      const travel = Math.hypot(e.point[0] - drag.start[0], e.point[1] - drag.start[1])
      if (travel * zoomOf(store()) < DRAG_SLOP) return
      drag =
        drag.target !== null || drag.inSelection
          ? startMove(drag.start)
          : { kind: 'marquee', start: drag.start, base: drag.shift ? store().selection : [] }
    }

    if (drag.kind === 'move') {
      let dx = e.point[0] - drag.start[0]
      let dy = e.point[1] - drag.start[1]
      // Ctrl or Cmd drags without snapping.
      if (drag.box && drag.targets && !e.mod) {
        const snap = snapMove(
          toSnapBox(shiftBox(drag.box, dx, dy)),
          drag.targets,
          currentThreshold(),
        )
        dx += snap.dx
        dy += snap.dy
        store().setGuides(snap.guides)
      } else store().setGuides([])
      const { nodes } = store().doc
      const patch: Record<NodeId, { transform: Transform }> = {}
      for (const [id, t] of drag.origins) {
        // A node in a turned group moves along the canvas, not along the group's axes.
        const [x, y] = deltaInParent(nodes, id, dx, dy)
        patch[id] = { transform: { ...t, x: t.x + x, y: t.y + y } }
      }
      store().updateNodes(patch)
    } else if (drag.kind === 'marquee') {
      const rect = rectBetween(drag.start, e.point)
      store().setMarquee(rect)
      store().select([
        ...drag.base,
        ...nodesInRect(store().doc, currentPageOf(store()).rootIds, rect),
      ])
    }
  },

  onUp() {
    const finished = drag
    drag = null
    if (!finished) return
    if (finished.kind === 'edit') startTextEdit(finished.id)
    else if (finished.kind === 'move') {
      store().setGuides([])
      store().endGesture()
    } else if (finished.kind === 'marquee') store().setMarquee(null)
    else if (finished.target !== null) {
      // A click on a node that was already selected: Shift removes it, a plain click keeps only it.
      if (finished.wasSelected)
        store().select([finished.target], finished.shift ? 'toggle' : 'replace')
    } else if (!finished.shift) store().select([])
  },

  onKey(e) {
    if (e.key === 'Escape') {
      if (drag) {
        selectTool.onCancel?.()
        return true
      }
      const { doc, selection } = store()
      if (selection.length === 0) return false
      // Out of a group one level at a time, then nothing.
      const entered = enteredGroup(doc, selection)
      store().select(entered === null ? [] : [entered])
      return true
    }
    const { doc, selection } = store()
    if (drag || selection.length === 0 || e.altKey) return false

    if (!(e.ctrlKey || e.metaKey)) {
      if (e.key === 'Delete' || e.key === 'Backspace') {
        store().deleteNodes(selection)
        return true
      }
      // Enter edits a text, or goes into a group, selecting what it holds.
      if (e.key === 'Enter' && selection.length === 1) {
        const node = doc.nodes[selection[0]]
        if (node?.type === 'text') startTextEdit(node.id)
        else if (node?.type === 'group') store().select(node.childIds)
        else return false
        return true
      }
      const arrow = ARROWS[e.key]
      if (!arrow) return false
      const step = e.shiftKey ? BIG_NUDGE : NUDGE
      store().nudge(selection, arrow[0] * step, arrow[1] * step)
      return true
    }

    const key = e.key.toLowerCase()
    if (key === 'g') {
      if (e.shiftKey) ungroupSelection()
      else store().group(selection)
    } else if (key === 'd') store().duplicate(selection)
    else if (key === 'c') store().copy(selection)
    else if (key === 'x') {
      store().copy(selection)
      store().deleteNodes(selection)
    }
    // By code, since Shift turns ] into } on most layouts.
    else if (e.code === 'BracketRight') store().reorder(selection, e.shiftKey ? 'front' : 'forward')
    else if (e.code === 'BracketLeft') store().reorder(selection, e.shiftKey ? 'back' : 'backward')
    else return false
    return true
  },

  onCancel() {
    const cancelled = drag
    drag = null
    if (cancelled?.kind === 'move') {
      store().setGuides([])
      store().cancelGesture()
    } else if (cancelled?.kind === 'marquee') store().setMarquee(null)
  },
}
