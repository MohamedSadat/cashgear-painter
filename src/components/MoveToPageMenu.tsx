import { Copy, FileOutput } from 'lucide-react'
import type { RefObject } from 'react'
import { moveSelectionToPage } from '../lib/pageActions'
import { useEditorStore } from '../store/editorStore'
import { Menu, type MenuItem } from './Menu'

interface MoveToPageMenuProps {
  at: { x: number; y: number } // the menu's top-left corner, in window pixels
  onClose(): void
  ignoreRef?: RefObject<HTMLElement | null>
}

/**
 * Moves or copies the selection to another page, where it is on this one: opened by a right-click
 * on the canvas, or by the properties panel's button on touch screens.
 */
export function MoveToPageMenu({ at, onClose, ignoreRef }: MoveToPageMenuProps) {
  const pages = useEditorStore((s) => s.doc.pages)
  const currentPageId = useEditorStore((s) => s.currentPageId)
  const others = pages.filter((page) => page.id !== currentPageId)
  const groups: MenuItem[][] =
    others.length === 0
      ? [[{ label: 'No other pages', disabled: true, run() {} }]]
      : [
          others.map((page) => ({
            label: `Move to ${page.name}`,
            icon: FileOutput,
            run: () => moveSelectionToPage(page.id, false),
          })),
          others.map((page) => ({
            label: `Copy to ${page.name}`,
            icon: Copy,
            run: () => moveSelectionToPage(page.id, true),
          })),
        ]
  return (
    <Menu
      label="Move to page"
      groups={groups}
      onClose={onClose}
      ignoreRef={ignoreRef}
      keepInView
      className="fixed max-h-[60vh]"
      style={{ left: at.x, top: at.y }}
    />
  )
}
