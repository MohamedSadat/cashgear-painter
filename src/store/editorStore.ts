import { produce, type Draft } from 'immer'
import { create } from 'zustand'
import {
  CANVAS_HEIGHT,
  CANVAS_WIDTH,
  IDENTITY_TRANSFORM,
  emptyDoc,
  type Doc,
  type NodeId,
  type Point,
  type StrokeNode,
  type ToolId,
  type VectorNode,
} from '../types'

export const HISTORY_LIMIT = 100
export const MIN_SIZE = 1
export const MAX_SIZE = 64
export const MIN_ZOOM = 0.1 // screen pixels per canvas unit
export const MAX_ZOOM = 32
export const NUDGE_MERGE_MS = 500 // arrow-key nudges this close together are one undo step
export const PASTE_OFFSET = 10 // canvas units between a copy and its duplicate or paste

export type ZOrder = 'forward' | 'backward' | 'front' | 'back'

/** An axis-aligned rectangle in canvas units. */
export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface Brush {
  color: string
  size: number
}

export interface View {
  scale: number // multiplies the viewport's fit scale; 1 = the artboard fits
  x: number // Stage position, in screen pixels
  y: number
}

export interface Viewport {
  width: number // Stage size, in screen pixels
  height: number
  fit: number // scale at which the artboard fits the canvas area
}

export interface EditorState {
  doc: Doc
  selection: NodeId[]
  past: Doc[] // undo stack (snapshots)
  future: Doc[] // redo stack
  gestureStart: Doc | null // doc when the current drag began
  tool: ToolId
  brush: Brush
  view: View // zoom and pan, not in history
  viewport: Viewport // measured canvas area; not in history or autosave
  draft: VectorNode | null // the node being drawn right now; not in history or autosave
  erasing: NodeId[] // nodes the eraser has touched in the current pass
  marquee: Rect | null // the select tool's drag rectangle
  clipboard: VectorNode[] // copied nodes with their descendants; not in history or autosave

  addNodes(nodes: VectorNode[], parentId?: NodeId): void
  updateNodes(patch: Record<NodeId, Partial<VectorNode>>): void
  deleteNodes(ids: NodeId[]): void
  reorder(ids: NodeId[], where: ZOrder): void
  nudge(ids: NodeId[], dx: number, dy: number): void
  duplicate(ids: NodeId[]): void
  copy(ids: NodeId[]): void
  paste(): void
  beginGesture(): void
  endGesture(): void
  cancelGesture(): void
  undo(): void
  redo(): void
  clear(): void
  select(ids: NodeId[], mode?: 'replace' | 'add' | 'toggle'): void
  setTool(t: ToolId): void
  setBrush(brush: Partial<Brush>): void
  setDraft(node: VectorNode | null): void
  setErasing(ids: NodeId[]): void
  setMarquee(rect: Rect | null): void
  setViewport(viewport: Viewport): void
  setView(view: View): void
  zoomTo(zoom: number, anchor?: [x: number, y: number]): void
  panBy(dx: number, dy: number): void
  fitView(): void
}

// crypto.randomUUID() is missing on plain-http LAN URLs (npm run dev -- --host), so ids are built by hand.
let idCounter = 0
export function newNodeId(): string {
  idCounter += 1
  return `${Date.now().toString(36)}-${idCounter.toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/** A freehand stroke at the top level: the brush color fills its outline. */
export function createStrokeNode(
  points: Point[],
  { color, size, usesPressure }: { color: string; size: number; usesPressure: boolean },
  id: NodeId = newNodeId(),
): StrokeNode {
  return {
    id,
    type: 'stroke',
    name: 'Stroke',
    parentId: null,
    transform: IDENTITY_TRANSFORM,
    style: { fill: color, stroke: null, strokeWidth: 0, opacity: 1 },
    hidden: false,
    locked: false,
    points,
    size,
    usesPressure,
  }
}

function pushSnapshot(past: Doc[], doc: Doc): Doc[] {
  const next = [...past, doc]
  return next.length > HISTORY_LIMIT ? next.slice(next.length - HISTORY_LIMIT) : next
}

/** Selected ids that still exist in `doc`; the same array when nothing was dropped. */
function existing(selection: NodeId[], doc: Doc): NodeId[] {
  const kept = selection.filter((id) => id in doc.nodes)
  return kept.length === selection.length ? selection : kept
}

export function clampSize(n: number): number {
  if (!Number.isFinite(n)) return MIN_SIZE
  return Math.min(MAX_SIZE, Math.max(MIN_SIZE, Math.round(n)))
}

export function clampZoom(zoom: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom))
}

/** Screen pixels per canvas unit: the Stage scale. */
export function zoomOf({ view, viewport }: Pick<EditorState, 'view' | 'viewport'>): number {
  return viewport.fit * view.scale
}

/** The nodes and every descendant, in z-order (bottom to top), parents before their children. */
function collectSubtrees(doc: Doc, ids: NodeId[]): VectorNode[] {
  const wanted = new Set(ids)
  const out: VectorNode[] = []
  const visit = (id: NodeId, take: boolean) => {
    const node = doc.nodes[id]
    if (!node) return
    const inside = take || wanted.has(id)
    if (inside) out.push(node)
    if (node.type === 'group') node.childIds.forEach((child) => visit(child, inside))
  }
  doc.rootIds.forEach((id) => visit(id, false))
  return out
}

/**
 * Copies of the nodes under new ids, with parent and child ids remapped. Nodes whose parent is not
 * among them become top level and are moved by `offset` canvas units on both axes.
 */
function withNewIds(
  nodes: VectorNode[],
  offset: number,
): { nodes: VectorNode[]; topIds: NodeId[] } {
  const ids = new Map(nodes.map((node) => [node.id, newNodeId()]))
  const topIds: NodeId[] = []
  const copies = nodes.map((node): VectorNode => {
    const id = ids.get(node.id)!
    const parentId = node.parentId === null ? null : (ids.get(node.parentId) ?? null)
    if (parentId === null) topIds.push(id)
    const transform =
      parentId === null
        ? { ...node.transform, x: node.transform.x + offset, y: node.transform.y + offset }
        : node.transform
    const copy = { ...node, id, parentId, transform }
    if (copy.type === 'group') {
      copy.childIds = copy.childIds.flatMap((child) => {
        const mapped = ids.get(child)
        return mapped === undefined ? [] : [mapped]
      })
    }
    return copy
  })
  return { nodes: copies, topIds }
}

/** A sibling list with the picked ids moved one step or all the way up or down, keeping their order. */
export function reorderIds(list: NodeId[], picked: ReadonlySet<NodeId>, where: ZOrder): NodeId[] {
  const isPicked = (id: NodeId) => picked.has(id)
  if (where === 'front') return [...list.filter((id) => !isPicked(id)), ...list.filter(isPicked)]
  if (where === 'back') return [...list.filter(isPicked), ...list.filter((id) => !isPicked(id))]
  const out = [...list]
  // Walking against the direction of travel moves a run of picked ids together.
  if (where === 'forward') {
    for (let i = out.length - 2; i >= 0; i--) {
      if (isPicked(out[i]) && !isPicked(out[i + 1])) [out[i], out[i + 1]] = [out[i + 1], out[i]]
    }
  } else {
    for (let i = 1; i < out.length; i++) {
      if (isPicked(out[i]) && !isPicked(out[i - 1])) [out[i], out[i - 1]] = [out[i - 1], out[i]]
    }
  }
  return out
}

const sameOrder = (a: NodeId[], b: NodeId[]) =>
  a.length === b.length && a.every((id, i) => id === b[i])

/** The view that centers the whole artboard in the viewport. */
function fittedView({ width, height, fit }: Viewport): View {
  return {
    scale: 1,
    x: (width - CANVAS_WIDTH * fit) / 2,
    y: (height - CANVAS_HEIGHT * fit) / 2,
  }
}

export const useEditorStore = create<EditorState>()((set, get) => {
  /**
   * Applies one edit to the doc. Outside a gesture it is one history step; inside one, the step
   * is recorded once at endGesture. An edit that changes nothing records nothing. `merge` folds
   * the edit into the latest step instead.
   */
  function commit(recipe: (doc: Draft<Doc>) => void, merge = false): void {
    const { doc, past, gestureStart } = get()
    const next = produce(doc, recipe)
    if (next === doc) return
    if (gestureStart || merge) set({ doc: next })
    else set({ doc: next, past: pushSnapshot(past, doc), future: [] })
  }

  /** Adds copies of the nodes on top of the z-order and selects them. */
  function insertCopies(nodes: VectorNode[], offset: number): void {
    const copies = withNewIds(nodes, offset)
    if (copies.topIds.length === 0) return
    commit((doc) => {
      for (const node of copies.nodes) doc.nodes[node.id] = node
      doc.rootIds.push(...copies.topIds)
    })
    set({ selection: copies.topIds })
  }

  // The doc the last nudge produced, and when: a nudge soon after, with no edit between, merges.
  let lastNudge: { at: number; doc: Doc } | null = null
  // Pastes since the last copy, so repeated pastes step away from the original.
  let pasteCount = 0

  return {
    doc: emptyDoc(),
    selection: [],
    past: [],
    future: [],
    gestureStart: null,
    tool: 'brush',
    brush: { color: '#000000', size: 8 },
    view: { scale: 1, x: 0, y: 0 },
    viewport: { width: 0, height: 0, fit: 0 },
    draft: null,
    erasing: [],
    marquee: null,
    clipboard: [],

    addNodes(nodes, parentId) {
      commit((doc) => {
        let order = doc.rootIds
        if (parentId !== undefined) {
          const parent = doc.nodes[parentId]
          if (parent?.type !== 'group') return
          order = parent.childIds
        }
        const parentKey = parentId ?? null
        for (const node of nodes) {
          if (node.id in doc.nodes) continue
          doc.nodes[node.id] = node.parentId === parentKey ? node : { ...node, parentId: parentKey }
          order.push(node.id)
        }
      })
    },

    updateNodes(patch) {
      commit((doc) => {
        for (const [id, changes] of Object.entries(patch)) {
          const node = doc.nodes[id]
          if (node) Object.assign(node, changes)
        }
      })
    },

    deleteNodes(ids) {
      commit((doc) => {
        // Deleting a group deletes everything inside it.
        const doomed = new Set<NodeId>()
        const collect = (id: NodeId) => {
          const node = doc.nodes[id]
          if (!node || doomed.has(id)) return
          doomed.add(id)
          if (node.type === 'group') node.childIds.forEach(collect)
        }
        ids.forEach(collect)
        if (doomed.size === 0) return

        const keep = (id: NodeId) => !doomed.has(id)
        if (!doc.rootIds.every(keep)) doc.rootIds = doc.rootIds.filter(keep)
        for (const node of Object.values(doc.nodes)) {
          if (node.type === 'group' && !doomed.has(node.id) && !node.childIds.every(keep)) {
            node.childIds = node.childIds.filter(keep)
          }
        }
        for (const id of doomed) delete doc.nodes[id]
      })
      const { selection, doc } = get()
      set({ selection: existing(selection, doc) })
    },

    reorder(ids, where) {
      const picked = new Set(ids)
      if (picked.size === 0) return
      commit((doc) => {
        const next = reorderIds(doc.rootIds, picked, where)
        if (!sameOrder(next, doc.rootIds)) doc.rootIds = next
        for (const node of Object.values(doc.nodes)) {
          if (node.type !== 'group') continue
          const children = reorderIds(node.childIds, picked, where)
          if (!sameOrder(children, node.childIds)) node.childIds = children
        }
      })
    },

    nudge(ids, dx, dy) {
      if (dx === 0 && dy === 0) return
      const now = Date.now()
      const merge =
        lastNudge !== null && lastNudge.doc === get().doc && now - lastNudge.at < NUDGE_MERGE_MS
      commit((doc) => {
        for (const id of ids) {
          const node = doc.nodes[id]
          if (!node || node.locked) continue
          node.transform = { ...node.transform, x: node.transform.x + dx, y: node.transform.y + dy }
        }
      }, merge)
      lastNudge = { at: now, doc: get().doc }
    },

    duplicate(ids) {
      insertCopies(collectSubtrees(get().doc, ids), PASTE_OFFSET)
    },

    copy(ids) {
      const nodes = collectSubtrees(get().doc, ids)
      if (nodes.length === 0) return
      pasteCount = 0
      set({ clipboard: nodes })
    },

    paste() {
      const { clipboard } = get()
      if (clipboard.length === 0) return
      pasteCount += 1
      insertCopies(clipboard, PASTE_OFFSET * pasteCount)
    },

    beginGesture() {
      const { gestureStart, doc } = get()
      if (gestureStart) return
      set({ gestureStart: doc })
    },

    endGesture() {
      const { gestureStart, doc, past } = get()
      if (!gestureStart) return
      if (doc === gestureStart) set({ gestureStart: null })
      else set({ gestureStart: null, past: pushSnapshot(past, gestureStart), future: [] })
    },

    cancelGesture() {
      const { gestureStart, selection } = get()
      if (!gestureStart) return
      set({ doc: gestureStart, gestureStart: null, selection: existing(selection, gestureStart) })
    },

    undo() {
      const { past, doc, future, gestureStart, selection } = get()
      const previous = past.at(-1)
      if (!previous || gestureStart) return
      set({
        doc: previous,
        past: past.slice(0, -1),
        future: [...future, doc],
        selection: existing(selection, previous),
      })
    },

    redo() {
      const { past, doc, future, gestureStart, selection } = get()
      const next = future.at(-1)
      if (!next || gestureStart) return
      set({
        doc: next,
        past: pushSnapshot(past, doc),
        future: future.slice(0, -1),
        selection: existing(selection, next),
      })
    },

    clear() {
      if (get().doc.rootIds.length === 0) return
      commit((doc) => {
        doc.nodes = {}
        doc.rootIds = []
      })
      set({ selection: [] })
    },

    select(ids, mode = 'replace') {
      const { doc, selection } = get()
      const picked = [...new Set(ids)].filter((id) => id in doc.nodes)
      if (mode === 'replace') set({ selection: picked })
      else if (mode === 'add') set({ selection: [...new Set([...selection, ...picked])] })
      else {
        const toggled = new Set(selection)
        for (const id of picked) {
          if (toggled.has(id)) toggled.delete(id)
          else toggled.add(id)
        }
        set({ selection: [...toggled] })
      }
    },

    setTool(t) {
      set({ tool: t })
    },

    setBrush(brush) {
      const current = get().brush
      set({ brush: { ...current, ...brush, size: clampSize(brush.size ?? current.size) } })
    },

    setDraft(node) {
      set({ draft: node })
    },

    setErasing(ids) {
      set({ erasing: ids })
    },

    setMarquee(rect) {
      set({ marquee: rect })
    },

    setViewport(next) {
      const { viewport, view } = get()
      if (
        next.width === viewport.width &&
        next.height === viewport.height &&
        next.fit === viewport.fit
      )
        return
      if (next.fit <= 0) set({ viewport: next })
      else if (viewport.fit <= 0) set({ viewport: next, view: fittedView(next) })
      else {
        // The canvas point in the middle stays in the middle, and the zoom stays relative to the fit.
        const before = zoomOf({ view, viewport })
        const after = next.fit * view.scale
        const cx = (viewport.width / 2 - view.x) / before
        const cy = (viewport.height / 2 - view.y) / before
        set({
          viewport: next,
          view: {
            scale: view.scale,
            x: next.width / 2 - cx * after,
            y: next.height / 2 - cy * after,
          },
        })
      }
    },

    setView(view) {
      set({ view })
    },

    zoomTo(zoom, anchor) {
      const state = get()
      const { view, viewport } = state
      if (viewport.fit <= 0 || !Number.isFinite(zoom)) return
      // The canvas point under the anchor stays under it; by default that is the middle.
      const [ax, ay] = anchor ?? [viewport.width / 2, viewport.height / 2]
      const after = clampZoom(zoom)
      const ratio = after / zoomOf(state)
      set({
        view: {
          scale: after / viewport.fit,
          x: ax - (ax - view.x) * ratio,
          y: ay - (ay - view.y) * ratio,
        },
      })
    },

    panBy(dx, dy) {
      const { view } = get()
      if (dx === 0 && dy === 0) return
      set({ view: { ...view, x: view.x + dx, y: view.y + dy } })
    },

    fitView() {
      const { viewport } = get()
      if (viewport.fit > 0) set({ view: fittedView(viewport) })
    },
  }
})
