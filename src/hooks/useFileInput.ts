import { useEffect } from 'react'
import { onCopy, onPaste } from '../lib/clipboard'
import { importFiles } from '../lib/imageActions'
import { isTextEntry } from './useShortcuts'

// The element files may be dropped on: the canvas.
export const DROP_TARGET_ATTR = 'data-file-drop'

const carriesFiles = (e: DragEvent) => e.dataTransfer?.types.includes('Files') ?? false

const onCanvas = (e: Event) =>
  e.target instanceof Element && e.target.closest(`[${DROP_TARGET_ATTR}]`) !== null

/**
 * Images and SVG files come in by paste (Ctrl/Cmd + V, or the browser's Paste) and by dropping
 * them on the canvas. A file dropped anywhere else is refused rather than opened by the browser
 * in place of the editor. Copies from the canvas mark the system clipboard (see onCopy).
 */
export function useFileInput(): void {
  useEffect(() => {
    const paste = (e: ClipboardEvent) => {
      if (!isTextEntry(e.target)) onPaste(e)
    }
    const copy = (e: ClipboardEvent) => {
      if (!isTextEntry(e.target)) onCopy(e)
    }
    const dragOver = (e: DragEvent) => {
      if (!carriesFiles(e)) return
      e.preventDefault()
      if (e.dataTransfer) e.dataTransfer.dropEffect = onCanvas(e) ? 'copy' : 'none'
    }
    const drop = (e: DragEvent) => {
      if (!carriesFiles(e)) return
      e.preventDefault()
      // Files that aren't images say so in a toast.
      if (onCanvas(e)) void importFiles([...(e.dataTransfer?.files ?? [])])
    }
    document.addEventListener('paste', paste)
    document.addEventListener('copy', copy)
    document.addEventListener('cut', copy)
    window.addEventListener('dragover', dragOver)
    window.addEventListener('drop', drop)
    return () => {
      document.removeEventListener('paste', paste)
      document.removeEventListener('copy', copy)
      document.removeEventListener('cut', copy)
      window.removeEventListener('dragover', dragOver)
      window.removeEventListener('drop', drop)
    }
  }, [])
}
