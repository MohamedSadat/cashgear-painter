import { useEffect } from 'react'
import { usePaintStore } from '../store/paintStore'

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

function isTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true
  if (target instanceof HTMLInputElement) return !NON_TEXT_INPUTS.has(target.type)
  return false
}

/** Ctrl/Cmd+Z undo · Ctrl/Cmd+Shift+Z or Ctrl+Y redo · B brush · E eraser · [ and ] brush size. */
export function useShortcuts(): void {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (isTextEntry(e.target)) return
      const store = usePaintStore.getState()
      const key = e.key.toLowerCase()

      if (e.ctrlKey || e.metaKey) {
        if (key === 'z') {
          e.preventDefault()
          if (e.shiftKey) store.redo()
          else store.undo()
        } else if (key === 'y') {
          e.preventDefault()
          store.redo()
        }
        return
      }
      if (e.altKey) return

      // Bigger steps for bigger brushes, so the whole 1–64 range is a few presses away.
      const step = Math.max(1, Math.round(store.size / 8))
      if (key === 'b') store.setTool('brush')
      else if (key === 'e') store.setTool('eraser')
      else if (e.key === '[') store.setSize(store.size - step)
      else if (e.key === ']') store.setSize(store.size + step)
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])
}
