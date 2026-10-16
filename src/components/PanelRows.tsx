import type { ReactNode } from 'react'
import { MIXED, type Value } from './panelValues'

// The rows the properties panel is made of, shared with its fill editor.

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

const SELECTED_RING = 'ring-2 ring-sky-500 ring-offset-1'
const SWATCH = 'h-6 w-6 shrink-0 rounded-full border border-black/15 sm:h-5 sm:w-5'

/**
 * A labelled control: the label beside it on phones, above it from 640 px up. A tall control
 * (`top`) has its label beside its first line rather than its middle.
 */
export function Row({
  label,
  mixed,
  top,
  children,
}: {
  label: string
  mixed?: boolean
  top?: boolean
  children: ReactNode
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className={`grid grid-cols-[3.5rem_1fr] gap-x-2 sm:grid-cols-1 sm:gap-y-1 ${top ? 'items-start' : 'items-center'}`}
    >
      <div
        className={`flex flex-col text-xs text-neutral-500 sm:flex-row sm:gap-1.5 ${top ? 'pt-2 sm:pt-0' : ''}`}
      >
        <span>{label}</span>
        {mixed && <span className="text-amber-700">Mixed</span>}
      </div>
      <div className="flex min-w-0 items-center gap-1">{children}</div>
    </div>
  )
}

const asHex = (value: Value<string | null>) =>
  typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value) ? value : '#000000'

interface SwatchesProps {
  label: string // names the buttons, such as "Fill #ef4444" and "Custom fill"
  value: Value<string | null>
  allowNone: boolean
  // The custom picker reports every color it passes through, under one merge key.
  onPick(color: string | null, mergeKey?: string): void
}

/** The color buttons: none (when allowed), the palette, and a custom color picker. */
export function Swatches({ label, value, allowNone, onPick }: SwatchesProps) {
  const name = label.toLowerCase()
  const isCustom = typeof value === 'string' && !SWATCHES.includes(value)
  return (
    <div className="flex flex-wrap items-center gap-1">
      {allowNone && (
        <button
          type="button"
          aria-label={`No ${name}`}
          aria-pressed={value === null}
          title={`No ${name}`}
          onClick={() => onPick(null)}
          className={`${SWATCH} bg-white bg-[linear-gradient(to_top_right,transparent_44%,#ef4444_44%,#ef4444_56%,transparent_56%)] ${value === null ? SELECTED_RING : ''}`}
        />
      )}
      {SWATCHES.map((swatch) => (
        <button
          key={swatch}
          type="button"
          aria-label={`${label} ${swatch}`}
          aria-pressed={value === swatch}
          title={swatch}
          onClick={() => onPick(swatch)}
          className={`${SWATCH} ${value === swatch ? SELECTED_RING : ''}`}
          style={{ backgroundColor: swatch }}
        />
      ))}
      <label
        title={`Custom ${name}`}
        className={`relative cursor-pointer ${SWATCH} ${isCustom ? SELECTED_RING : ''}`}
        style={{
          background: isCustom
            ? value
            : 'conic-gradient(#ef4444, #eab308, #22c55e, #06b6d4, #3b82f6, #a855f7, #ef4444)',
        }}
      >
        <input
          type="color"
          aria-label={`Custom ${name}`}
          value={asHex(value)}
          onChange={(e) => onPick(e.target.value, name)}
          className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
        />
      </label>
    </div>
  )
}

/** A row of color swatches, such as an outline's. */
export function ColorRow(props: SwatchesProps) {
  return (
    <Row label={props.label} mixed={props.value === MIXED}>
      <Swatches {...props} />
    </Row>
  )
}

interface SliderRowProps {
  label: string
  ariaLabel: string
  min: number
  max: number
  value: Value<number>
  format?(n: number): string
  disabled?: boolean
  onChange(n: number): void
}

export function SliderRow({
  label,
  ariaLabel,
  min,
  max,
  value,
  format = String,
  disabled,
  onChange,
}: SliderRowProps) {
  const position = value === MIXED ? min : Math.min(max, Math.max(min, value))
  return (
    <Row label={label}>
      <input
        type="range"
        aria-label={ariaLabel}
        min={min}
        max={max}
        value={position}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
        className="min-w-0 flex-1 accent-sky-600 disabled:opacity-35"
      />
      <span className="w-11 shrink-0 text-right text-xs text-neutral-600 tabular-nums">
        {value === MIXED ? 'Mixed' : format(value)}
      </span>
    </Row>
  )
}

export interface Choice<T extends string> {
  value: T
  label: string
  title: string
}

interface ChoicesProps<T extends string> {
  label: string
  options: Choice<T>[]
  value: T | null // null: none pressed, as for mixed values
  onPick(value: T): void
}

/** Buttons for one of a few options, the current one pressed, such as an anchor's kind. */
export function Choices<T extends string>({ label, options, value, onPick }: ChoicesProps<T>) {
  return (
    <div role="group" aria-label={label} className="flex flex-wrap items-center gap-0.5">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={value === option.value}
          title={option.title}
          onClick={() => onPick(option.value)}
          className={`h-8 rounded-md px-2 text-xs transition-colors ${
            value === option.value
              ? 'bg-sky-100 text-sky-700'
              : 'text-neutral-700 hover:bg-neutral-100'
          }`}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}
