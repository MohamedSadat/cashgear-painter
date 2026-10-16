import { useEditorStore } from '../store/editorStore'
import { settleTool } from '../tools'
import { finishTextEdit } from '../tools/textTool'

const store = () => useEditorStore.getState()

/** Ends what is being drawn or typed, keeping it on the page it was begun on. */
function settle() {
  finishTextEdit()
  settleTool()
}

/** Shows another page, with its own zoom and pan. */
export function goToPage(id: string): void {
  if (id === store().currentPageId) return
  settle()
  store().setCurrentPage(id)
}

/** Shows the page before (-1) or after (1) the current one, as PageUp and PageDown do. */
export function goToNeighbourPage(step: -1 | 1): void {
  const { doc, currentPageId } = store()
  const index = doc.pages.findIndex((page) => page.id === currentPageId)
  const next = doc.pages[index + step]
  if (next) goToPage(next.id)
}

/** Adds an empty page after the current one, the same size, and shows it. One undo step. */
export function addPage(): void {
  settle()
  store().addPage()
}

/** Adds a copy of the page after it and shows it. One undo step. */
export function duplicatePage(id: string): void {
  settle()
  store().duplicatePage(id)
}

/** Deletes the page and what is on it; the last page can't go. One undo step. */
export function deletePage(id: string): void {
  settle()
  store().deletePage(id)
}

/** Moves or copies the selected objects to another page, where they are on this one. */
export function moveSelectionToPage(pageId: string, copy: boolean): void {
  settle()
  const { selection, moveToPage } = store()
  moveToPage(selection, pageId, copy)
}
