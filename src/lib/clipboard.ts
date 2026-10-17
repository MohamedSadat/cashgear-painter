import { useEditorStore } from '../store/editorStore'
import { importFiles, isSvgFile } from './imageActions'

const store = () => useEditorStore.getState()

// What the editor puts on the system clipboard when it copies objects, so a later paste knows the
// clipboard holds them rather than an image copied elsewhere before. Objects themselves stay in
// the editor (the store's clipboard): navigator.clipboard needs a secure context.
export const PAINTER_CLIPBOARD_TYPE = 'application/x-simple-painter'
// How long Ctrl/Cmd + V waits for the browser's paste event before pasting the editor's own
// clipboard: browsers send it right after the key, but not for every page or every browser.
const PASTE_FALLBACK_MS = 50

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml'])

let copying = false
let pasteFallback: ReturnType<typeof setTimeout> | null = null

/** Pastes the editor's own clipboard with the select tool, offset from the copies before it. */
export function pasteObjects(): void {
  const state = store()
  if (state.clipboard.length === 0) return
  state.setTool('select')
  state.paste()
}

/** Ctrl/Cmd + V: the paste event that follows decides what to paste (see onPaste). */
export function expectPaste(): void {
  if (pasteFallback !== null) clearTimeout(pasteFallback)
  pasteFallback = setTimeout(() => {
    pasteFallback = null
    pasteObjects()
  }, PASTE_FALLBACK_MS)
}

/** Ctrl/Cmd + C or X copied objects: the copy event that follows marks the system clipboard. */
export function expectCopy(): void {
  copying = true
  setTimeout(() => (copying = false), 0)
}

/** The copy or cut event after the editor copied objects: the system clipboard says so. */
export function onCopy(e: ClipboardEvent): void {
  if (!copying || !e.clipboardData) return
  copying = false
  e.clipboardData.setData(PAINTER_CLIPBOARD_TYPE, '1')
  e.preventDefault()
}

/** PNG, JPEG, WebP and SVG files among the data, as a paste or a drop holds them. */
export function importableFiles(data: DataTransfer | null): File[] {
  if (!data) return []
  return [...data.files].filter(
    (file) =>
      IMAGE_TYPES.has(file.type) || isSvgFile(file) || /\.(png|jpe?g|webp)$/i.test(file.name),
  )
}

/**
 * A paste outside text fields: an image copied elsewhere is imported (see importFiles), unless
 * the editor's own copy came after it; otherwise the editor's clipboard is pasted.
 */
export function onPaste(e: ClipboardEvent): void {
  if (pasteFallback !== null) {
    clearTimeout(pasteFallback)
    pasteFallback = null
  }
  const data = e.clipboardData
  const ours = data?.types.includes(PAINTER_CLIPBOARD_TYPE) ?? false
  const files = ours ? [] : importableFiles(data)
  if (files.length > 0) {
    e.preventDefault()
    void importFiles(files)
  } else if (store().clipboard.length > 0) {
    e.preventDefault()
    pasteObjects()
  }
}
