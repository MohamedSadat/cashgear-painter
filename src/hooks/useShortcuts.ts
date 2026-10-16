import { useEffect } from 'react'
import { useEditorStore } from '../store/editorStore'
import { toolFor } from '../tools'
import type { ToolId } from '../types'

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

const TOOL_KEYS: Record<string, ToolId> = {
  v: 'select',
  a: 'direct',
  b: 'brush',
  e: 'eraser',
  r: 'rect',
  o: 'ellipse',
  l: 'line',
  p: 'pen',
  h: 'hand',
}

export function isTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true
  if (target instanceof HTMLInputElement) return !NON_TEXT_INPUTS.has(target.type)
  return false
}

/**
 * The active tool sees each key first (the select tool's are in selectTool.ts); Esc otherwise
 * cancels what the tool is doing. Then: Ctrl/Cmd+Z undo · Ctrl/Cmd+Shift+Z or Ctrl+Y redo ·
 * Ctrl/Cmd+A select all · Ctrl/Cmd+V paste · Ctrl/Cmd+0 fit · Ctrl/Cmd+1 100% · V select ·
 * A direct select · B brush · E eraser · R rectangle · O ellipse · L line · P pen · H hand ·
 * [ and ] brush size. Space for the hand tool is in useViewport.
 */
export function useShortcuts(): void {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (isTextEntry(e.target)) return
      // A focused slider keeps its arrow keys.
      if (e.target instanceof HTMLInputElement && e.key.startsWith('Arrow')) return
      const store = useEditorStore.getState()
      const key = e.key.toLowerCase()

      const active = toolFor(store.tool)
      if (active?.onKey?.(e)) {
        e.preventDefault()
        return
      }
      if (e.key === 'Escape') {
        active?.onCancel?.()
        return
      }

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
        } else if (key === 'a') {
          e.preventDefault()
          const { doc } = store
          store.setTool('select')
          store.select(doc.rootIds.filter((id) => !doc.nodes[id].hidden && !doc.nodes[id].locked))
        } else if (key === 'v' && store.clipboard.length > 0) {
          e.preventDefault()
          store.setTool('select')
          store.paste()
        }
        return
      }
      if (e.altKey) return

      // Bigger steps for bigger brushes, so the whole 1–64 range is a few presses away.
      const { size } = store.brush
      const step = Math.max(1, Math.round(size / 8))
      if (Object.hasOwn(TOOL_KEYS, key)) store.setTool(TOOL_KEYS[key])
      else if (e.key === '[') store.setBrush({ size: size - step })
      else if (e.key === ']') store.setBrush({ size: size + step })
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])
}
