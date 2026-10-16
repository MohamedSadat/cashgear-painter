import { Lock, LockOpen, RotateCw } from 'lucide-react'
import { useMemo, useRef, useState, type ReactNode } from 'react'
import { boxOf, type Axis, type Patch } from '../lib/align/align'
import { evalMath } from '../lib/align/evalMath'
import {
  canStretch,
  movePatch,
  resizePatch,
  rotatePatch,
  sharedRotation,
  withPatch,
} from '../lib/align/numeric'
import { outermost, useEditorStore } from '../store/editorStore'
import { IconButton } from './ToolRail'

const store = () => useEditorStore.getState()

/** A value as a field shows it: at most 2 decimals, which the model isn't rounded to. */
const formatNumber = (n: number) => String(Math.round(n * 100) / 100)

// Typed values further from 0 than this are refused.
const MAX_VALUE = 100_000

interface NumberFieldProps {
  label: string
  prefix: ReactNode // shown in the field, before the value
  value: number | null // null: mixed, or nothing to show
  suffix?: string
  disabled?: boolean
  onCommit(n: number): void
}

/**
 * A number applied on Enter or when the field loses focus; Esc puts it back. Arithmetic such as
 * 200/3 is worked out. While not being edited it shows the value live. It applies through the
 * handler of the render it was focused in, so a click on the canvas that blurs it and selects
 * something else applies the value to what was selected while typing.
 */
function NumberField({ label, prefix, value, suffix, disabled, onCommit }: NumberFieldProps) {
  const shown = value === null ? '' : formatNumber(value)
  const [draft, setDraft] = useState<string | null>(null)
  const commitRef = useRef(onCommit)
  const cancelled = useRef(false)

  const finish = (text: string) => {
    setDraft(null)
    if (cancelled.current) return
    if (text.trim() === shown) return
    const n = evalMath(text)
    if (n !== null && Math.abs(n) <= MAX_VALUE) commitRef.current(n)
  }

  return (
    <label
      className={`flex h-8 min-w-0 items-center gap-1 rounded-md border border-neutral-300 bg-white px-1.5 focus-within:border-sky-500 ${
        disabled ? 'opacity-50' : ''
      }`}
    >
      <span aria-hidden className="flex shrink-0 text-xs text-neutral-500">
        {prefix}
      </span>
      <input
        type="text"
        aria-label={label}
        value={draft ?? shown}
        placeholder={value === null && !disabled ? 'Mixed' : undefined}
        disabled={disabled}
        spellCheck={false}
        autoComplete="off"
        onFocus={(e) => {
          commitRef.current = onCommit
          cancelled.current = false
          setDraft(shown)
          e.currentTarget.select()
        }}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={(e) => finish(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') cancelled.current = true
          if (e.key === 'Enter' || e.key === 'Escape') e.currentTarget.blur()
        }}
        className="h-full min-w-0 flex-1 bg-transparent text-sm text-neutral-800 tabular-nums outline-none placeholder:text-amber-700"
      />
      {suffix && (
        <span aria-hidden className="shrink-0 text-xs text-neutral-500">
          {suffix}
        </span>
      )}
    </label>
  )
}

const apply = (patch: Patch) => store().updateNodes(patch)

/**
 * X, Y, W, H and rotation fields for the selection, at the top of the properties panel. They go
 * by the selection's ink box on the page, the box align and snapping use, so a rotated object
 * shows its axis-aligned box; rotation is on the canvas, Mixed when the objects differ. They
 * follow a drag live, the Transformer's through the store's preview. Each change is one undo
 * step: X and Y move the box, W and H resize it about its top-left corner (keeping the ratio
 * while the lock is on, and always for turned objects and a single text), and rotation turns
 * each object about its own middle.
 */
export function TransformFields() {
  const doc = useEditorStore((s) => s.doc)
  const selection = useEditorStore((s) => s.selection)
  const preview = useEditorStore((s) => s.transformPreview)
  const ratioLocked = useEditorStore((s) => s.ratioLocked)
  const ids = useMemo(() => outermost(doc, selection), [doc, selection])
  const nodes = useMemo(() => (preview ? withPatch(doc.nodes, preview) : doc.nodes), [doc, preview])
  const box = boxOf(nodes, ids)
  const rotation = sharedRotation(nodes, ids)
  const stretch = canStretch(doc.nodes, ids)
  const none = box === null

  // Each handler acts on the selection of its render, with the doc as it is when it applies.
  const move = (x: number | null, y: number | null) =>
    apply(movePatch(store().doc.nodes, ids, x, y))
  const resize = (axis: Axis, length: number) => {
    const { doc, ratioLocked } = store()
    apply(resizePatch(doc.nodes, ids, axis, length, ratioLocked || !canStretch(doc.nodes, ids)))
  }
  const turn = (degrees: number) => apply(rotatePatch(store().doc.nodes, ids, degrees))

  return (
    <div
      role="group"
      aria-label="Position and size"
      className="grid grid-cols-[minmax(0,1fr)_2rem_minmax(0,1fr)] items-center gap-1"
    >
      <NumberField
        label="X"
        prefix="X"
        value={box && box.minX}
        disabled={none}
        onCommit={(x) => move(x, null)}
      />
      <span aria-hidden />
      <NumberField
        label="Y"
        prefix="Y"
        value={box && box.minY}
        disabled={none}
        onCommit={(y) => move(null, y)}
      />
      <NumberField
        label="Width"
        prefix="W"
        value={box && box.maxX - box.minX}
        disabled={none}
        onCommit={(w) => resize('x', w)}
      />
      <IconButton
        label="Keep ratio"
        title={stretch ? 'Keep the ratio' : 'Turned objects and a single text keep their ratio'}
        pressed={ratioLocked || !stretch}
        disabled={none || !stretch}
        compact
        onClick={() => store().setRatioLocked(!ratioLocked)}
      >
        {ratioLocked || !stretch ? <Lock size={16} /> : <LockOpen size={16} />}
      </IconButton>
      <NumberField
        label="Height"
        prefix="H"
        value={box && box.maxY - box.minY}
        disabled={none}
        onCommit={(h) => resize('y', h)}
      />
      <NumberField
        label="Rotation"
        prefix={<RotateCw size={12} />}
        value={rotation}
        suffix="°"
        disabled={none}
        onCommit={turn}
      />
    </div>
  )
}
