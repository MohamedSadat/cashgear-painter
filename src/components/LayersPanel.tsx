import {
  Brush,
  ChevronDown,
  ChevronRight,
  Circle,
  Eye,
  EyeOff,
  Folder,
  GripVertical,
  Lock,
  LockOpen,
  PenTool,
  Slash,
  Square,
  Type,
  type LucideIcon,
} from 'lucide-react'
import { useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import { useRowDrag } from '../hooks/useRowDrag'
import { currentPageOf, isWithin, useEditorStore } from '../store/editorStore'
import type { Doc, NodeId, NodeType, Page, VectorNode } from '../types'

const store = () => useEditorStore.getState()

const TYPE_ICONS: Record<NodeType, LucideIcon> = {
  stroke: Brush,
  rect: Square,
  ellipse: Circle,
  line: Slash,
  path: PenTool,
  text: Type,
  group: Folder,
}

// Two clicks or taps on a name this soon rename the layer, besides the browser's dblclick, which
// phones don't always send.
const DOUBLE_MS = 400

interface LayerRow {
  node: VectorNode
  depth: number
  expanded: boolean // a group whose children show below it
  inHidden: boolean // inside a hidden group
}

/** Where a dragged layer lands: above or below a row, inside a group on top, or at the bottom. */
type DropTarget = { id: NodeId; where: 'above' | 'below' | 'inside' } | { id: null; where: 'end' }

/**
 * The page's tree as rows, front-most first; a collapsed group hides its children unless one is
 * selected.
 */
function layerRows(
  doc: Doc,
  page: Page,
  collapsed: ReadonlySet<NodeId>,
  open: ReadonlySet<NodeId>,
): LayerRow[] {
  const rows: LayerRow[] = []
  const visit = (ids: NodeId[], depth: number, inHidden: boolean) => {
    for (let i = ids.length - 1; i >= 0; i--) {
      const node = doc.nodes[ids[i]]
      if (!node) continue
      const expanded = node.type === 'group' && (!collapsed.has(node.id) || open.has(node.id))
      rows.push({ node, depth, expanded, inHidden })
      if (node.type === 'group' && expanded)
        visit(node.childIds, depth + 1, inHidden || node.hidden)
    }
  }
  visit(page.rootIds, 0, false)
  return rows
}

/** The groups the selected nodes are in, which show their children whatever their state. */
function selectionAncestors(doc: Doc, selection: NodeId[]): Set<NodeId> {
  const open = new Set<NodeId>()
  for (const id of selection) {
    for (let p = doc.nodes[id]?.parentId ?? null; p !== null; p = doc.nodes[p]?.parentId ?? null) {
      open.add(p)
    }
  }
  return open
}

/** The moveNodes call a drop makes; null when the target is one of the moved layers or in one. */
function dropMove(
  doc: Doc,
  page: Page,
  ids: NodeId[],
  target: DropTarget,
): { parentId: NodeId | null; index: number } | null {
  if (target.id === null) return { parentId: null, index: 0 }
  if (ids.some((id) => isWithin(doc, target.id, id))) return null
  const node = doc.nodes[target.id]
  if (target.where === 'inside' && node.type === 'group') {
    return { parentId: node.id, index: node.childIds.filter((c) => !ids.includes(c)).length }
  }
  const siblings =
    node.parentId === null
      ? page.rootIds
      : (doc.nodes[node.parentId] as { childIds: NodeId[] }).childIds
  const index = siblings.filter((s) => !ids.includes(s)).indexOf(node.id)
  // Front-most is on top, so above a row is in front of it: one step higher in the z-order.
  return { parentId: node.parentId, index: target.where === 'above' ? index + 1 : index }
}

/**
 * The node tree, front-most on top. A row selects its object (Shift, Ctrl or Cmd adds), its eye
 * hides it and its lock keeps it from being picked on the canvas; double-click or double-tap the
 * name to rename it. Drag a row to reorder it or move it in or out of a group: anywhere on the row
 * with a mouse or pen, by its grip with a finger, so the list still scrolls by touch. App places
 * it: under the properties on the right from 640 px up, a tab of the bottom sheet on phones.
 */
export function LayersPanel({ className = '' }: { className?: string }) {
  const doc = useEditorStore((s) => s.doc)
  const page = useEditorStore(currentPageOf)
  const selection = useEditorStore((s) => s.selection)
  const [collapsed, setCollapsed] = useState<ReadonlySet<NodeId>>(new Set())
  const [renaming, setRenaming] = useState<NodeId | null>(null)
  const [drop, setDrop] = useState<DropTarget | null>(null)
  const listRef = useRef<HTMLUListElement>(null)
  const lastClick = useRef<{ id: NodeId; at: number } | null>(null)

  const rows = layerRows(doc, page, collapsed, selectionAncestors(doc, selection))
  const selected = new Set(selection)

  /** The layers a drag of `id` moves: the whole selection when the row is in it. */
  const draggedIds = (id: NodeId) => (selection.includes(id) ? selection : [id])

  const targetAt = (clientY: number): DropTarget | null => {
    const list = listRef.current
    if (!list) return null
    const items = [...list.querySelectorAll<HTMLElement>('[data-layer-id]')]
    for (const item of items) {
      const box = item.getBoundingClientRect()
      if (clientY < box.top || clientY > box.bottom) continue
      const id = item.dataset.layerId!
      const at = (clientY - box.top) / box.height
      if (doc.nodes[id]?.type === 'group') {
        // An open group's lower part is the top of its children, which follow it.
        if (at < 0.25) return { id, where: 'above' }
        if (item.dataset.expanded !== 'true' && at > 0.75) return { id, where: 'below' }
        return { id, where: 'inside' }
      }
      return { id, where: at < 0.5 ? 'above' : 'below' }
    }
    const last = items.at(-1)
    return last && clientY > last.getBoundingClientRect().bottom ? { id: null, where: 'end' } : null
  }

  const drag = useRowDrag({
    listRef,
    axis: 'y',
    blocked: renaming !== null,
    onMove(id, e) {
      const target = targetAt(e.clientY)
      setDrop(target && dropMove(doc, page, draggedIds(id), target) ? target : null)
    },
    onEnd(id, e) {
      setDrop(null)
      if (!e) return
      const target = targetAt(e.clientY)
      const ids = draggedIds(id)
      const move = target && dropMove(doc, page, ids, target)
      if (move) store().moveNodes(ids, move.parentId, move.index)
    },
  })

  const onNameClick = (e: ReactMouseEvent, node: VectorNode) => {
    if (drag.takeClick()) return
    // Timed by the clicks' own events, not when they are handled: the first click's re-render can
    // hold the second one back.
    const now = e.timeStamp
    const previous = lastClick.current
    lastClick.current = { id: node.id, at: now }
    if (previous?.id === node.id && now - previous.at < DOUBLE_MS) {
      lastClick.current = null
      setRenaming(node.id)
      return
    }
    const { tool, setTool, select } = store()
    // Handles show with the select tool; direct select and the hand keep working as they are.
    if (tool !== 'select' && tool !== 'direct' && tool !== 'hand') setTool('select')
    select([node.id], e.shiftKey || e.ctrlKey || e.metaKey ? 'toggle' : 'replace')
  }

  const rename = (node: VectorNode, value: string) => {
    setRenaming(null)
    const name = value.trim()
    if (name !== '' && name !== node.name) store().updateNodes({ [node.id]: { name } })
  }

  const toggleCollapsed = (id: NodeId) => {
    const next = new Set(collapsed)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setCollapsed(next)
  }

  return (
    <aside aria-label="Layers" className={`flex min-h-0 flex-col ${className}`}>
      <h2 className="hidden px-3 pt-2 pb-1 text-sm font-semibold text-neutral-800 sm:block">
        Layers
      </h2>
      {rows.length === 0 ? (
        <p className="px-4 py-2 text-xs text-neutral-500 sm:px-3">
          Each object you draw gets a layer here.
        </p>
      ) : (
        <ul
          ref={listRef}
          role="tree"
          aria-label="Layer list"
          aria-multiselectable
          className="min-h-0 flex-1 overflow-y-auto pb-2"
        >
          {rows.map(({ node, depth, expanded, inHidden }) => {
            const Icon = TYPE_ICONS[node.type]
            const isSelected = selected.has(node.id)
            const target = drop?.id === node.id ? drop.where : null
            return (
              <li
                key={node.id}
                role="treeitem"
                aria-label={node.name}
                aria-level={depth + 1}
                aria-selected={isSelected}
                aria-expanded={node.type === 'group' ? expanded : undefined}
                data-layer-id={node.id}
                data-expanded={expanded}
                onPointerDown={(e) => drag.onPointerDown(e, node.id)}
                onPointerMove={drag.onPointerMove}
                onPointerUp={drag.onPointerUp}
                onPointerCancel={drag.onPointerCancel}
                className={`relative flex h-9 items-center gap-1 pr-1 select-none ${
                  isSelected ? 'bg-sky-100' : 'hover:bg-neutral-50'
                } ${target === 'inside' ? 'ring-2 ring-sky-500 ring-inset' : ''}`}
                style={{ paddingLeft: 4 + depth * 14 }}
              >
                {(target === 'above' || target === 'below') && (
                  <div
                    aria-hidden
                    className={`absolute right-0 h-0.5 bg-sky-500 ${target === 'above' ? 'top-0' : 'bottom-0'}`}
                    style={{ left: 4 + depth * 14 }}
                  />
                )}
                <span
                  data-grip
                  aria-hidden
                  className="flex h-9 w-6 shrink-0 cursor-grab touch-none items-center justify-center text-neutral-400"
                >
                  <GripVertical size={14} />
                </span>
                {node.type === 'group' ? (
                  <button
                    type="button"
                    aria-label={`${expanded ? 'Collapse' : 'Expand'} ${node.name}`}
                    onClick={() => toggleCollapsed(node.id)}
                    className="flex h-9 w-5 shrink-0 items-center justify-center text-neutral-500"
                  >
                    {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                  </button>
                ) : (
                  <span className="w-5 shrink-0" />
                )}
                <Icon size={14} aria-hidden className="shrink-0 text-neutral-500" />
                {renaming === node.id ? (
                  <input
                    aria-label="Layer name"
                    defaultValue={node.name}
                    autoFocus
                    onFocus={(e) => e.currentTarget.select()}
                    onBlur={(e) => rename(node, e.currentTarget.value)}
                    onKeyDown={(e) => {
                      // Esc puts the name back first, so the blur that follows keeps it.
                      if (e.key === 'Escape') e.currentTarget.value = node.name
                      if (e.key === 'Enter' || e.key === 'Escape') e.currentTarget.blur()
                    }}
                    className="h-7 min-w-0 flex-1 rounded border border-sky-500 px-1 text-sm"
                  />
                ) : (
                  <button
                    type="button"
                    title={`${node.name}: double-click to rename`}
                    onClick={(e) => onNameClick(e, node)}
                    // Mice get the browser's own double-click too, timed by the input events.
                    onDoubleClick={() => setRenaming(node.id)}
                    className={`h-9 min-w-0 flex-1 truncate text-left text-sm ${
                      node.hidden || inHidden ? 'text-neutral-400' : 'text-neutral-800'
                    }`}
                  >
                    {node.name}
                  </button>
                )}
                <button
                  type="button"
                  aria-label={`${node.hidden ? 'Show' : 'Hide'} ${node.name}`}
                  aria-pressed={node.hidden}
                  title={node.hidden ? 'Show' : 'Hide'}
                  onClick={() => store().updateNodes({ [node.id]: { hidden: !node.hidden } })}
                  className={`flex h-9 w-8 shrink-0 items-center justify-center rounded-md hover:bg-neutral-100 ${
                    node.hidden ? 'text-neutral-800' : 'text-neutral-400'
                  }`}
                >
                  {node.hidden ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
                <button
                  type="button"
                  aria-label={`${node.locked ? 'Unlock' : 'Lock'} ${node.name}`}
                  aria-pressed={node.locked}
                  title={node.locked ? 'Unlock' : 'Lock'}
                  onClick={() => store().updateNodes({ [node.id]: { locked: !node.locked } })}
                  className={`flex h-9 w-8 shrink-0 items-center justify-center rounded-md hover:bg-neutral-100 ${
                    node.locked ? 'text-neutral-800' : 'text-neutral-400'
                  }`}
                >
                  {node.locked ? <Lock size={16} /> : <LockOpen size={16} />}
                </button>
              </li>
            )
          })}
          {drop?.id === null && <li aria-hidden className="mx-1 h-0.5 bg-sky-500" />}
        </ul>
      )}
    </aside>
  )
}
