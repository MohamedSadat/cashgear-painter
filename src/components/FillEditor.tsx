import { ArrowLeftRight, Trash2 } from 'lucide-react'
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import {
  gradientFrom,
  isGradient,
  paintColor,
  reverseStops,
  sameStops,
  samePaint,
  solid,
  sortedStops,
  stopAt,
  stopCss,
  type PaintKind,
} from '../lib/paint/paint'
import { useEditorStore } from '../store/editorStore'
import type { Paint, Stop } from '../types'
import { Choices, Row, Swatches, type Choice } from './PanelRows'
import { MIXED, shared } from './panelValues'
import { IconButton } from './ToolRail'

const store = () => useEditorStore.getState()

/** One fill the row edits: a selected object's, the next shape's or the page's background. */
export interface FillTarget {
  fill: Paint | null
  canClear: boolean // freehand strokes, text and backgrounds always have a fill
  fallback: string // the color a fill starts from when there was none
}

type FillKind = PaintKind | 'none'

const KINDS: Choice<FillKind>[] = [
  { value: 'none', label: 'None', title: 'No fill' },
  { value: 'solid', label: 'Solid', title: 'One color' },
  { value: 'linear', label: 'Linear', title: 'Linear gradient: drag its ends on the canvas' },
  {
    value: 'radial',
    label: 'Radial',
    title: 'Radial gradient: drag its center and radius on the canvas',
  },
]

const kindOf = (fill: Paint | null): FillKind => fill?.kind ?? 'none'

/** The fill each target gets when the type switch picks `kind`. */
function convert(target: FillTarget, kind: FillKind): Paint | null {
  const { fill, fallback } = target
  switch (kind) {
    case 'none':
      return null
    case 'solid':
      return fill?.kind === 'solid' ? fill : solid(fill === null ? fallback : paintColor(fill))
    case 'linear':
    case 'radial':
      return gradientFrom(kind, fill, fallback)
  }
}

interface FillRowProps {
  label: string // 'Fill', 'Color' or 'Background'; names the row and its swatches
  targets: FillTarget[]
  /** The new fill of each target, in order; edits sharing `mergeKey` soon after are one step. */
  onApply(fills: (Paint | null)[], mergeKey?: string): void
}

/**
 * A fill: its type (None, Solid, Linear, Radial), then color swatches for a solid fill or the
 * stop bar for a gradient. A change applies to every target; None only to those that can do
 * without a fill. The swatches also show for no fill, so one click fills a shape. With targets
 * that disagree, the row says Mixed and the type switch shows none pressed.
 */
export function FillRow({ label, targets, onApply }: FillRowProps) {
  const fills = targets.map((t) => t.fill)
  const kind = shared(fills.map(kindOf))
  const first = fills[0]
  const mixed =
    kind === MIXED ||
    !fills.every((fill) =>
      isGradient(fill) && isGradient(first)
        ? sameStops(fill.stops, first.stops)
        : samePaint(fill, first),
    )
  const allowNone = targets.some((t) => t.canClear)

  const apply = (fill: (target: FillTarget) => Paint | null, mergeKey?: string) =>
    onApply(
      targets.map((t) => {
        const next = fill(t)
        return next === null && !t.canClear ? t.fill : next
      }),
      mergeKey,
    )

  const color = shared(fills.map((fill) => (fill === null ? null : paintColor(fill))))
  return (
    <Row label={label} mixed={mixed} top>
      <div className="flex min-w-0 flex-1 flex-col items-start gap-1.5">
        <Choices
          label={`${label} type`}
          options={allowNone ? KINDS : KINDS.slice(1)}
          value={kind === MIXED ? null : kind}
          onPick={(k) => apply((t) => convert(t, k))}
        />
        {isGradient(first) && kind === first.kind ? (
          <GradientEditor
            stops={first.stops}
            onStops={(stops, mergeKey) =>
              apply((t) => (isGradient(t.fill) ? { ...t.fill, stops } : t.fill), mergeKey)
            }
          />
        ) : (
          <Swatches
            label={label}
            value={kind === 'solid' || kind === 'none' ? color : MIXED}
            allowNone={false}
            onPick={(c, mergeKey) => {
              if (c !== null) apply(() => solid(c), mergeKey)
            }}
          />
        )}
      </div>
    </Row>
  )
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, n))
const percentOf = (offset: number) => Math.round(offset * 100)

// A checkerboard under the stop bar, so see-through stops show as such.
const CHECKER = 'repeating-conic-gradient(#d4d4d4 0% 25%, #ffffff 0% 50%) 0 0 / 8px 8px'

interface GradientEditorProps {
  stops: Stop[]
  onStops(stops: Stop[], mergeKey?: string): void
}

/**
 * The stop bar: the gradient from left to right, with a marker under it per stop. A click on the
 * bar adds a stop there in the color the gradient has there; dragging a marker moves its stop,
 * as one undo step; arrow keys move a focused marker (Shift for 10%) and Delete removes it. The
 * picked stop's color and opacity are below, with Delete stop, and a button reverses the stops.
 * A gradient keeps at least 2 stops.
 */
function GradientEditor({ stops, onStops }: GradientEditorProps) {
  const [picked, setPicked] = useState(0)
  const index = Math.min(picked, stops.length - 1)
  const stop = stops[index]
  const barRef = useRef<HTMLDivElement>(null)
  const dragging = useRef<number | null>(null)
  // A drag cut short by the editor going away still closes its undo step.
  useEffect(
    () => () => {
      if (dragging.current !== null) store().endGesture()
    },
    [],
  )

  const offsetAt = (clientX: number) => {
    const rect = barRef.current?.getBoundingClientRect()
    if (!rect || rect.width <= 0) return 0
    return clamp01((clientX - rect.left) / rect.width)
  }
  const setStop = (i: number, changes: Partial<Stop>, mergeKey?: string) =>
    onStops(
      stops.map((s, j) => (j === i ? { ...s, ...changes } : s)),
      mergeKey,
    )
  const remove = (i: number) => {
    if (stops.length <= 2) return
    onStops(stops.filter((_, j) => j !== i))
    setPicked(Math.max(0, i - 1))
  }

  const addStop = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    const offset = offsetAt(e.clientX)
    onStops([...stops, stopAt(stops, offset)])
    setPicked(stops.length)
  }

  const startDrag = (i: number, e: PointerEvent<HTMLButtonElement>) => {
    setPicked(i)
    if (e.button !== 0) return
    e.currentTarget.setPointerCapture(e.pointerId)
    dragging.current = e.pointerId
    store().beginGesture()
  }
  const moveDrag = (i: number, e: PointerEvent<HTMLButtonElement>) => {
    if (dragging.current !== e.pointerId) return
    const offset = offsetAt(e.clientX)
    if (offset !== stops[i].offset) setStop(i, { offset })
  }
  const endDrag = (e: PointerEvent<HTMLButtonElement>) => {
    if (dragging.current !== e.pointerId) return
    dragging.current = null
    store().endGesture()
  }

  const onMarkerKey = (i: number, e: KeyboardEvent<HTMLButtonElement>) => {
    const step = e.shiftKey ? 0.1 : 0.01
    const keys: Record<string, () => void> = {
      ArrowLeft: () => setStop(i, { offset: clamp01(stops[i].offset - step) }, 'gradient-stop'),
      ArrowDown: () => setStop(i, { offset: clamp01(stops[i].offset - step) }, 'gradient-stop'),
      ArrowRight: () => setStop(i, { offset: clamp01(stops[i].offset + step) }, 'gradient-stop'),
      ArrowUp: () => setStop(i, { offset: clamp01(stops[i].offset + step) }, 'gradient-stop'),
      Home: () => setStop(i, { offset: 0 }),
      End: () => setStop(i, { offset: 1 }),
      Delete: () => remove(i),
      Backspace: () => remove(i),
    }
    const run = keys[e.key]
    if (!run) return
    // The canvas's own shortcuts (Delete, arrows) mustn't act on the selection as well.
    e.preventDefault()
    e.stopPropagation()
    run()
  }

  const bar = `linear-gradient(to right, ${sortedStops(stops)
    .map((s) => `${stopCss(s)} ${s.offset * 100}%`)
    .join(', ')}), ${CHECKER}`

  return (
    <div className="flex w-full min-w-0 flex-col gap-1.5">
      <div className="flex w-full items-start gap-1">
        {/* Room on both sides for half a marker at either end. */}
        <div className="relative mx-1.5 h-10 min-w-0 flex-1">
          <div
            ref={barRef}
            aria-hidden
            title="Click to add a stop"
            onPointerDown={addStop}
            className="absolute inset-x-0 top-0 h-5 cursor-copy rounded border border-black/15"
            style={{ background: bar }}
          />
          {stops.map((s, i) => (
            <button
              key={i}
              type="button"
              role="slider"
              aria-label={`Stop ${i + 1}`}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={percentOf(s.offset)}
              aria-valuetext={`${percentOf(s.offset)}%`}
              title={`Stop at ${percentOf(s.offset)}%: drag to move, Delete to remove`}
              onPointerDown={(e) => startDrag(i, e)}
              onPointerMove={(e) => moveDrag(i, e)}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
              onLostPointerCapture={endDrag}
              onFocus={() => setPicked(i)}
              onKeyDown={(e) => onMarkerKey(i, e)}
              className={`absolute top-3.5 h-6 w-3.5 -translate-x-1/2 touch-none rounded-sm border-2 shadow-sm ${
                i === index ? 'border-sky-500' : 'border-white ring-1 ring-black/25'
              }`}
              style={{ left: `${clamp01(s.offset) * 100}%`, backgroundColor: s.color }}
            />
          ))}
        </div>
        <IconButton
          label="Reverse gradient"
          compact
          onClick={() => {
            onStops(reverseStops(stops))
            setPicked(stops.length - 1 - index)
          }}
        >
          <ArrowLeftRight size={18} />
        </IconButton>
      </div>
      <Swatches
        label="Stop"
        value={stop.color}
        allowNone={false}
        onPick={(color, mergeKey) => {
          if (color !== null) setStop(index, { color }, mergeKey && 'stop-color')
        }}
      />
      <div className="flex w-full items-center gap-1">
        <input
          type="range"
          aria-label="Stop opacity"
          min={0}
          max={100}
          value={Math.round(stop.opacity * 100)}
          onChange={(e) =>
            setStop(index, { opacity: Number(e.target.value) / 100 }, 'stop-opacity')
          }
          className="min-w-0 flex-1 accent-sky-600"
        />
        <span className="w-10 shrink-0 text-right text-xs text-neutral-600 tabular-nums">
          {Math.round(stop.opacity * 100)}%
        </span>
        <IconButton
          label="Delete stop"
          title={stops.length <= 2 ? 'A gradient needs 2 stops' : 'Delete stop (Del)'}
          disabled={stops.length <= 2}
          compact
          danger
          onClick={() => remove(index)}
        >
          <Trash2 size={18} />
        </IconButton>
      </div>
    </div>
  )
}
