import { useEffect } from 'react'
import { useEditorStore } from '../store/editorStore'

// Inputs that don't take typed text; shortcuts keep working while one of these has focus.
const NON_TEXT_INPUTS = new Set([
  'range',
  'color',
  'checkbox',
  'radio',
  'button',
  'submit',
  'reset',
])

export function isTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true
  if (target instanceof HTMLInputElement) return !NON_TEXT_INPUTS.has(target.type)
  return false
}

/**
 * Ctrl/Cmd+Z undo · Ctrl/Cmd+Shift+Z or Ctrl+Y redo · Ctrl/Cmd+0 fit · Ctrl/Cmd+1 100% ·
 * B brush · E eraser · H hand · [ and ] brush size. Space for the hand tool is in useViewport.
 */
export function useShortcuts(): void {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (isTextEntry(e.target)) return
      const store = useEditorStore.getState()
      const key = e.key.toLowerCase()

      if (e.ctrlKey || e.metaKey) {
        if (key === 'z') {
          e.preventDefault()
          if (e.shiftKey) store.redo()
          else store.undo()
        } else if (key === 'y') {
          e.preventDefault()
          store.redo()
        } else if (key === '0') {
          // Instead of the browser's own zoom reset.
          e.preventDefault()
          store.fitView()
        } else if (key === '1') {
          e.preventDefault()
          store.zoomTo(1)
        }
        return
      }
      if (e.altKey) return

      // Bigger steps for bigger brushes, so the whole 1–64 range is a few presses away.
      const { size } = store.brush
      const step = Math.max(1, Math.round(size / 8))
      if (key === 'b') store.setTool('brush')
      else if (key === 'e') store.setTool('eraser')
      else if (key === 'h') store.setTool('hand')
      else if (e.key === '[') store.setBrush({ size: size - step })
      else if (e.key === ']') store.setBrush({ size: size + step })
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])
}
