import { Brush, Download, Eraser, Redo2, Trash2, Undo2 } from 'lucide-react'
import type { ReactNode } from 'react'
import { MAX_SIZE, MIN_SIZE, useEditorStore } from '../store/editorStore'

const SWATCHES = [
  '#000000',
  '#6b7280',
  '#ef4444',
  '#f97316',
  '#eab308',
  '#22c55e',
  '#3b82f6',
  '#a855f7',
]

const SELECTED_RING = 'ring-2 ring-sky-500 ring-offset-2'

interface IconButtonProps {
  label: string
  title?: string
  pressed?: boolean
  disabled?: boolean
  onClick(): void
  children: ReactNode
}

function IconButton({ label, title, pressed, disabled, onClick, children }: IconButtonProps) {
  return (
    <button
      type="button"
      aria-label={label}
      title={title ?? label}
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onClick}
      className={`flex h-9 w-9 items-center justify-center rounded-md transition-colors disabled:cursor-not-allowed disabled:opacity-35 ${
        pressed ? 'bg-sky-100 text-sky-700' : 'text-neutral-700 enabled:hover:bg-neutral-100'
      }`}
    >
      {children}
    </button>
  )
}

interface ToolbarProps {
  onExport(): void
}

export function Toolbar({ onExport }: ToolbarProps) {
  const tool = useEditorStore((s) => s.tool)
  const color = useEditorStore((s) => s.brush.color)
  const size = useEditorStore((s) => s.brush.size)
  const canUndo = useEditorStore((s) => s.past.length > 0)
  const canRedo = useEditorStore((s) => s.future.length > 0)
  const canClear = useEditorStore((s) => s.doc.rootIds.length > 0)
  const { setTool, setBrush, undo, redo, clear } = useEditorStore.getState()

  // Picking a color means you want to paint with it.
  const pickColor = (c: string) => {
    setBrush({ color: c })
    setTool('brush')
  }
  const isCustomColor = !SWATCHES.includes(color)

  return (
    <header className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-neutral-200 bg-white px-2 py-1.5 sm:gap-x-5 sm:px-4">
      <div role="group" aria-label="Tools" className="flex items-center gap-1">
        <IconButton
          label="Brush"
          title="Brush (B)"
          pressed={tool === 'brush'}
          onClick={() => setTool('brush')}
        >
          <Brush size={20} />
        </IconButton>
        <IconButton
          label="Eraser"
          title="Eraser (E)"
          pressed={tool === 'eraser'}
          onClick={() => setTool('eraser')}
        >
          <Eraser size={20} />
        </IconButton>
      </div>

      <div role="group" aria-label="Colors" className="flex items-center gap-1">
        {SWATCHES.map((swatch) => (
          <button
            key={swatch}
            type="button"
            aria-label={`Color ${swatch}`}
            aria-pressed={color === swatch}
            title={swatch}
            onClick={() => pickColor(swatch)}
            className={`h-6 w-6 rounded-full border border-black/15 ${color === swatch ? SELECTED_RING : ''}`}
            style={{ backgroundColor: swatch }}
          />
        ))}
        <label
          title="Custom color"
          className={`relative ml-1 h-6 w-6 cursor-pointer rounded-full border border-black/15 ${isCustomColor ? SELECTED_RING : ''}`}
          style={{
            background: isCustomColor
              ? color
              : 'conic-gradient(#ef4444, #eab308, #22c55e, #06b6d4, #3b82f6, #a855f7, #ef4444)',
          }}
        >
          <input
            type="color"
            aria-label="Custom color"
            value={color}
            onChange={(e) => pickColor(e.target.value)}
            className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
          />
        </label>
      </div>

      <label className="flex items-center gap-2 text-sm text-neutral-600">
        <span>Size</span>
        <input
          type="range"
          aria-label="Brush size"
          min={MIN_SIZE}
          max={MAX_SIZE}
          value={size}
          onChange={(e) => setBrush({ size: Number(e.target.value) })}
          className="w-24 accent-sky-600 sm:w-32"
        />
        <span className="w-5 text-right tabular-nums">{size}</span>
      </label>

      <div className="ml-auto flex items-center gap-1">
        <div role="group" aria-label="History" className="flex items-center gap-1">
          <IconButton label="Undo" title="Undo (Ctrl+Z)" disabled={!canUndo} onClick={undo}>
            <Undo2 size={20} />
          </IconButton>
          <IconButton label="Redo" title="Redo (Ctrl+Shift+Z)" disabled={!canRedo} onClick={redo}>
            <Redo2 size={20} />
          </IconButton>
          <IconButton label="Clear" disabled={!canClear} onClick={clear}>
            <Trash2 size={20} />
          </IconButton>
        </div>
        <IconButton label="Export PNG" onClick={onExport}>
          <Download size={20} />
        </IconButton>
      </div>
    </header>
  )
}
