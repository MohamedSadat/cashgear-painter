import { CopyPlus, GripVertical, Plus, Trash2 } from 'lucide-react'
import { useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import { useRowDrag } from '../hooks/useRowDrag'
import { addPage, deletePage, duplicatePage, goToPage } from '../lib/pageActions'
import { useThumbnail } from '../lib/thumbnails'
import { useEditorStore } from '../store/editorStore'
import type { Page } from '../types'
import { IconButton } from './ToolRail'

const store = () => useEditorStore.getState()

// Two clicks or taps on a page this soon rename it, besides the browser's dblclick, which phones
// don't always send.
const DOUBLE_MS = 400

/** A page's picture: its SVG export, drawn by the thumbnails module. */
function Thumbnail({ page }: { page: Page }) {
  const url = useThumbnail(page.id)
  return (
    <span className="flex h-16 w-full items-center justify-center overflow-hidden rounded bg-neutral-100">
      {url ? (
        <img src={url} alt="" draggable={false} className="max-h-full max-w-full object-contain" />
      ) : (
        // Until it is drawn, a blank page of the right shape.
        <span
          className="max-h-full max-w-full bg-white"
          style={{ aspectRatio: `${page.width} / ${page.height}`, height: '100%' }}
        />
      )}
    </span>
  )
}

interface PagesPanelProps {
  // A vertical strip beside the canvas from 640 px up; a row that scrolls sideways on phones.
  layout: 'strip' | 'row'
  className?: string
}

/**
 * The document's pages as thumbnails, in order. A click shows a page; double-click or double-tap
 * renames it. Drag a page to reorder: anywhere with a mouse or pen, by its grip with a finger.
 * The buttons on top add a page after the current one, duplicate it or delete it; each change is
 * one undo step.
 */
export function PagesPanel({ layout, className = '' }: PagesPanelProps) {
  const pages = useEditorStore((s) => s.doc.pages)
  const currentPageId = useEditorStore((s) => s.currentPageId)
  const [renaming, setRenaming] = useState<string | null>(null)
  // Where a dragged page would go: an index among all the pages, its own place included.
  const [slot, setSlot] = useState<number | null>(null)
  const listRef = useRef<HTMLOListElement>(null)
  const lastClick = useRef<{ id: string; at: number } | null>(null)
  const vertical = layout === 'strip'

  /** The slot before the first page whose middle lies past the pointer, along the list. */
  const slotAt = (clientX: number, clientY: number) => {
    const items = [...(listRef.current?.querySelectorAll<HTMLElement>('[data-page-id]') ?? [])]
    const at = vertical ? clientY : clientX
    const index = items.findIndex((item) => {
      const box = item.getBoundingClientRect()
      return at < (vertical ? box.top + box.height / 2 : box.left + box.width / 2)
    })
    return index < 0 ? items.length : index
  }

  // The index movePage wants, counted without the moved page; null when it wouldn't move.
  const targetIndex = (id: string, to: number) => {
    const from = pages.findIndex((page) => page.id === id)
    const index = to > from ? to - 1 : to
    return index === from ? null : index
  }

  const drag = useRowDrag({
    listRef,
    axis: vertical ? 'y' : 'x',
    blocked: renaming !== null,
    onMove(id, e) {
      const to = slotAt(e.clientX, e.clientY)
      setSlot(targetIndex(id, to) === null ? null : to)
    },
    onEnd(id, e) {
      setSlot(null)
      if (!e) return
      const index = targetIndex(id, slotAt(e.clientX, e.clientY))
      if (index !== null) store().movePage(id, index)
    },
  })

  const onPageClick = (e: ReactMouseEvent, page: Page) => {
    if (drag.takeClick()) return
    // Timed by the clicks' own events, not when they are handled.
    const previous = lastClick.current
    lastClick.current = { id: page.id, at: e.timeStamp }
    if (previous?.id === page.id && e.timeStamp - previous.at < DOUBLE_MS) {
      lastClick.current = null
      setRenaming(page.id)
      return
    }
    goToPage(page.id)
  }

  const rename = (page: Page, value: string) => {
    setRenaming(null)
    store().updatePage(page.id, { name: value })
  }

  const marker = vertical ? 'inset-x-1 h-0.5' : 'inset-y-1 w-0.5'

  return (
    <aside aria-label="Pages" className={`flex min-h-0 flex-col ${className}`}>
      <div
        className={`flex shrink-0 items-center gap-0.5 px-2 pt-2 pb-1 ${vertical ? 'flex-col items-stretch' : ''}`}
      >
        <h2 className={`text-sm font-semibold text-neutral-800 ${vertical ? 'px-1' : 'sr-only'}`}>
          Pages
        </h2>
        <div role="group" aria-label="Page actions" className="flex items-center justify-between">
          <IconButton label="Add page" title="Add a page after this one" compact onClick={addPage}>
            <Plus size={18} />
          </IconButton>
          <IconButton label="Duplicate page" compact onClick={() => duplicatePage(currentPageId)}>
            <CopyPlus size={18} />
          </IconButton>
          <IconButton
            label="Delete page"
            danger
            compact
            disabled={pages.length < 2}
            onClick={() => deletePage(currentPageId)}
          >
            <Trash2 size={18} />
          </IconButton>
        </div>
      </div>
      <ol
        ref={listRef}
        aria-label="Page list"
        className={`flex min-h-0 flex-1 gap-2 px-2 pb-2 ${
          vertical ? 'flex-col overflow-y-auto' : 'flex-row overflow-x-auto'
        }`}
      >
        {pages.map((page, index) => {
          const current = page.id === currentPageId
          return (
            <li
              key={page.id}
              data-page-id={page.id}
              onPointerDown={(e) => drag.onPointerDown(e, page.id)}
              onPointerMove={drag.onPointerMove}
              onPointerUp={drag.onPointerUp}
              onPointerCancel={drag.onPointerCancel}
              className={`relative flex shrink-0 flex-col gap-1 select-none ${vertical ? '' : 'w-24'}`}
            >
              {slot === index && (
                <div
                  aria-hidden
                  className={`absolute bg-sky-500 ${marker} ${vertical ? '-top-1.5' : '-left-1.5'}`}
                />
              )}
              {slot === pages.length && index === pages.length - 1 && (
                <div
                  aria-hidden
                  className={`absolute bg-sky-500 ${marker} ${vertical ? '-bottom-1.5' : '-right-1.5'}`}
                />
              )}
              <button
                type="button"
                aria-label={page.name}
                aria-current={current ? 'page' : undefined}
                title={`${page.name}: double-click to rename`}
                onClick={(e) => onPageClick(e, page)}
                // Mice get the browser's own double-click too.
                onDoubleClick={() => setRenaming(page.id)}
                className={`rounded-md border-2 p-0.5 ${
                  current ? 'border-sky-500' : 'border-transparent hover:border-neutral-300'
                }`}
              >
                <Thumbnail page={page} />
              </button>
              <div className="flex min-w-0 items-center gap-0.5">
                <span
                  data-grip
                  aria-hidden
                  className="flex h-6 w-4 shrink-0 cursor-grab touch-none items-center justify-center text-neutral-400"
                >
                  <GripVertical size={12} />
                </span>
                <span className="shrink-0 text-xs text-neutral-500 tabular-nums">{index + 1}</span>
                {renaming === page.id ? (
                  <input
                    aria-label="Page name"
                    defaultValue={page.name}
                    autoFocus
                    onFocus={(e) => e.currentTarget.select()}
                    onBlur={(e) => rename(page, e.currentTarget.value)}
                    onKeyDown={(e) => {
                      // Esc puts the name back first, so the blur that follows keeps it.
                      if (e.key === 'Escape') e.currentTarget.value = page.name
                      if (e.key === 'Enter' || e.key === 'Escape') e.currentTarget.blur()
                    }}
                    className="h-6 min-w-0 flex-1 rounded border border-sky-500 px-1 text-xs"
                  />
                ) : (
                  <span
                    className={`min-w-0 flex-1 truncate text-xs ${current ? 'font-medium text-sky-700' : 'text-neutral-700'}`}
                  >
                    {page.name}
                  </span>
                )}
              </div>
            </li>
          )
        })}
      </ol>
    </aside>
  )
}
