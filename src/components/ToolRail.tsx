import {
  Brush,
  Circle,
  Download,
  Eraser,
  Hand,
  MousePointer2,
  PenTool,
  Redo2,
  Slash,
  SplinePointer,
  Square,
  Trash2,
  Undo2,
  type LucideIcon,
} from 'lucide-react'
import { Fragment, type ReactNode } from 'react'
import { useEditorStore, zoomOf } from '../store/editorStore'
import type { ToolId } from '../types'

interface IconButtonProps {
  label: string
  title?: string
  pressed?: boolean | 'mixed'
  disabled?: boolean
  danger?: boolean
  onClick(): void
  children: ReactNode
}

export function IconButton({
  label,
  title,
  pressed,
  disabled,
  danger,
  onClick,
  children,
}: IconButtonProps) {
  const tone =
    pressed === true
      ? 'bg-sky-100 text-sky-700'
      : danger
        ? 'text-neutral-700 enabled:hover:bg-red-50 enabled:hover:text-red-600'
        : 'text-neutral-700 enabled:hover:bg-neutral-100'
  return (
    <button
      type="button"
      aria-label={label}
      title={title ?? label}
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onClick}
      className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-md transition-colors disabled:cursor-not-allowed disabled:opacity-35 ${tone} ${
        pressed === 'mixed' ? 'bg-neutral-100' : ''
      }`}
    >
      {children}
    </button>
  )
}

interface ToolButton {
  id: ToolId
  label: string
  title: string
  icon: LucideIcon
}

// Separated into groups: picking and painting, shapes and paths, then the view.
const TOOL_GROUPS: ToolButton[][] = [
  [
    { id: 'select', label: 'Select', title: 'Select (V)', icon: MousePointer2 },
    {
      id: 'direct',
      label: 'Direct select',
      title: 'Direct select: edit anchors (A)',
      icon: SplinePointer,
    },
    { id: 'brush', label: 'Brush', title: 'Brush (B)', icon: Brush },
    { id: 'eraser', label: 'Eraser', title: 'Eraser (E)', icon: Eraser },
  ],
  [
    { id: 'rect', label: 'Rectangle', title: 'Rectangle (R)', icon: Square },
    { id: 'ellipse', label: 'Ellipse', title: 'Ellipse (O)', icon: Circle },
    { id: 'line', label: 'Line', title: 'Line / arrow (L)', icon: Slash },
    { id: 'pen', label: 'Pen', title: 'Pen (P)', icon: PenTool },
  ],
  [{ id: 'hand', label: 'Hand', title: 'Hand (H, or hold Space)', icon: Hand }],
]

const SEPARATOR = 'mx-0.5 h-6 w-px bg-neutral-200 sm:mx-0 sm:my-1 sm:h-px sm:w-6'

interface ToolRailProps {
  onExport(): void
}

/**
 * The tools, then history, zoom and export. A vertical rail on the left from 640 px up; above the
 * canvas, wrapping onto a second row, on phones.
 */
export function ToolRail({ onExport }: ToolRailProps) {
  const tool = useEditorStore((s) => s.tool)
  const canUndo = useEditorStore((s) => s.past.length > 0)
  const canRedo = useEditorStore((s) => s.future.length > 0)
  const canClear = useEditorStore((s) => s.doc.rootIds.length > 0)
  const zoomPercent = useEditorStore((s) => Math.round(zoomOf(s) * 100))
  const { setTool, undo, redo, clear, fitView } = useEditorStore.getState()

  return (
    <nav className="flex shrink-0 flex-wrap items-center gap-1 border-b border-neutral-200 bg-white px-2 py-1 sm:flex-col sm:flex-nowrap sm:border-r sm:border-b-0 sm:px-1 sm:py-2">
      {/* No gaps on phones, so the nine tools fit one row from 360 px up; narrower ones wrap. */}
      <div
        role="group"
        aria-label="Tools"
        className="flex flex-wrap items-center sm:flex-col sm:flex-nowrap sm:gap-0.5"
      >
        {TOOL_GROUPS.map((group, i) => (
          <Fragment key={group[0].id}>
            {i > 0 && <div aria-hidden className={SEPARATOR} />}
            {group.map(({ id, label, title, icon: Icon }) => (
              <IconButton
                key={id}
                label={label}
                title={title}
                pressed={tool === id}
                onClick={() => setTool(id)}
              >
                <Icon size={20} />
              </IconButton>
            ))}
          </Fragment>
        ))}
      </div>

      <div className="ml-auto flex items-center gap-0.5 sm:mt-auto sm:ml-0 sm:flex-col">
        <div role="group" aria-label="History" className="flex items-center gap-0.5 sm:flex-col">
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
        <div aria-hidden className={SEPARATOR} />
        {/* Shows the zoom and fits the artboard, so touch screens have a way back too. */}
        <button
          type="button"
          aria-label="Fit artboard"
          title="Fit artboard (Ctrl+0)"
          onClick={fitView}
          className="h-9 w-14 rounded-md text-sm text-neutral-600 tabular-nums hover:bg-neutral-100 sm:w-11 sm:text-xs"
        >
          {zoomPercent}%
        </button>
        <IconButton label="Export PNG" onClick={onExport}>
          <Download size={20} />
        </IconButton>
      </div>
    </nav>
  )
}
