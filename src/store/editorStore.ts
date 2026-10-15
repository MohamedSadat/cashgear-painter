import { produce, type Draft } from 'immer'
import { create } from 'zustand'
import {
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

export interface Brush {
  color: string
  size: number
}

export interface View {
  scale: number
  x: number
  y: number
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
  draft: VectorNode | null // the node being drawn right now; not in history or autosave
  erasing: NodeId[] // nodes the eraser has touched in the current pass

  addNodes(nodes: VectorNode[], parentId?: NodeId): void
  updateNodes(patch: Record<NodeId, Partial<VectorNode>>): void
  deleteNodes(ids: NodeId[]): void
  beginGesture(): void
  endGesture(): void
  undo(): void
  redo(): void
  clear(): void
  select(ids: NodeId[], mode?: 'replace' | 'add' | 'toggle'): void
  setTool(t: ToolId): void
  setBrush(brush: Partial<Brush>): void
  setDraft(node: VectorNode | null): void
  setErasing(ids: NodeId[]): void
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

export const useEditorStore = create<EditorState>()((set, get) => {
  /**
   * Applies one edit to the doc. Outside a gesture it is one history step; inside one, the step
   * is recorded once at endGesture. An edit that changes nothing records nothing.
   */
  function commit(recipe: (doc: Draft<Doc>) => void): void {
    const { doc, past, gestureStart } = get()
    const next = produce(doc, recipe)
    if (next === doc) return
    if (gestureStart) set({ doc: next })
    else set({ doc: next, past: pushSnapshot(past, doc), future: [] })
  }

  return {
    doc: emptyDoc(),
    selection: [],
    past: [],
    future: [],
    gestureStart: null,
    tool: 'brush',
    brush: { color: '#000000', size: 8 },
    view: { scale: 1, x: 0, y: 0 },
    draft: null,
    erasing: [],

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
  }
})
