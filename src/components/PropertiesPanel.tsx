import {
  ArrowDown,
  ArrowUp,
  BringToFront,
  CopyPlus,
  MoveLeft,
  MoveRight,
  SendToBack,
  Trash2,
} from 'lucide-react'
import type { ReactNode } from 'react'
import { MAX_SIZE, MIN_SIZE, useEditorStore, type ZOrder } from '../store/editorStore'
import { lineStyleOf } from '../tools/shapeTools'
import type { NodeId, NodeOf, Style, VectorNode } from '../types'
import { IconButton } from './ToolRail'

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

/** Selected objects disagree on a value. */
const MIXED = Symbol('mixed')
type Value<T> = T | typeof MIXED

/** The value every item has, or MIXED. */
function shared<T>(values: T[]): Value<T> {
  return values.every((v) => v === values[0]) ? values[0] : MIXED
}

const store = () => useEditorStore.getState()

// Which style each node type has: freehand strokes are all fill and lines all outline, so neither
// can do without its color.
const hasFill = (n: VectorNode) => n.type === 'stroke' || n.type === 'rect' || n.type === 'ellipse'
const hasOutline = (n: VectorNode) => n.type === 'rect' || n.type === 'ellipse' || n.type === 'line'
const canClearColor = (n: VectorNode) => n.type === 'rect' || n.type === 'ellipse'

/**
 * Applies style changes to the nodes as one undo step; nodes that already have them are left out.
 * Changes sharing `mergeKey` in quick succession (a slider drag, a color picker) are one step too.
 */
function restyle(nodes: VectorNode[], changes: Partial<Style>, mergeKey?: string) {
  const patch: Record<NodeId, Partial<VectorNode>> = {}
  for (const node of nodes) {
    const style: Style = { ...node.style, ...changes }
    const same = (Object.keys(changes) as (keyof Style)[]).every((k) => node.style[k] === style[k])
    if (!same) patch[node.id] = { style }
  }
  if (Object.keys(patch).length > 0) store().updateNodes(patch, mergeKey)
}

function Header({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <h2 className="mr-auto truncate text-sm font-semibold text-neutral-800">{title}</h2>
      {children}
    </div>
  )
}

/** A labelled control: the label beside it on phones, above it from 640 px up. */
function Row({ label, mixed, children }: { label: string; mixed?: boolean; children: ReactNode }) {
  return (
    <div
      role="group"
      aria-label={label}
      className="grid grid-cols-[3.5rem_1fr] items-center gap-x-2 sm:grid-cols-1 sm:gap-y-1"
    >
      <div className="flex flex-col text-xs text-neutral-500 sm:flex-row sm:gap-1.5">
        <span>{label}</span>
        {mixed && <span className="text-amber-700">Mixed</span>}
      </div>
      <div className="flex min-w-0 items-center gap-1">{children}</div>
    </div>
  )
}

const asHex = (value: Value<string | null>) =>
  typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value) ? value : '#000000'

interface ColorRowProps {
  label: string
  value: Value<string | null>
  allowNone: boolean
  // The custom picker reports every color it passes through, under one merge key.
  onPick(color: string | null, mergeKey?: string): void
}

function ColorRow({ label, value, allowNone, onPick }: ColorRowProps) {
  const name = label.toLowerCase()
  const isCustom = typeof value === 'string' && !SWATCHES.includes(value)
  return (
    <Row label={label} mixed={value === MIXED}>
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

function SliderRow({
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

const percent = (n: number) => `${n}%`

// Delete, duplicate and z-order have shortcuts too; these buttons are for touch screens.
const ARRANGE: { label: string; title: string; where: ZOrder; icon: ReactNode }[] = [
  {
    label: 'Bring to front',
    title: 'Bring to front (Ctrl+Shift+])',
    where: 'front',
    icon: <BringToFront size={18} />,
  },
  {
    label: 'Bring forward',
    title: 'Bring forward (Ctrl+])',
    where: 'forward',
    icon: <ArrowUp size={18} />,
  },
  {
    label: 'Send backward',
    title: 'Send backward (Ctrl+[)',
    where: 'backward',
    icon: <ArrowDown size={18} />,
  },
  {
    label: 'Send to back',
    title: 'Send to back (Ctrl+Shift+[)',
    where: 'back',
    icon: <SendToBack size={18} />,
  },
]

function SelectionProperties() {
  const doc = useEditorStore((s) => s.doc)
  const selection = useEditorStore((s) => s.selection)
  const nodes = selection.flatMap((id) => (id in doc.nodes ? [doc.nodes[id]] : []))

  if (nodes.length === 0) {
    return (
      <>
        <Header title="Nothing selected" />
        <p className="text-xs text-neutral-500">
          Tap or click an object to change its style. Drag across empty canvas to select several.
        </p>
      </>
    )
  }

  const filled = nodes.filter(hasFill)
  const outlined = nodes.filter(hasOutline)
  const rects = nodes.filter((n): n is NodeOf<'rect'> => n.type === 'rect')
  const lines = nodes.filter((n): n is NodeOf<'line'> => n.type === 'line')
  // Konva and SVG round corners to at most half the shorter side.
  const radiusOf = (r: NodeOf<'rect'>) =>
    Math.round(Math.min(r.cornerRadius, r.width / 2, r.height / 2))
  const maxRadius = Math.max(1, ...rects.map((r) => Math.floor(Math.min(r.width, r.height) / 2)))

  const setArrow = (key: 'arrowStart' | 'arrowEnd', on: boolean) => {
    const patch: Record<NodeId, Partial<VectorNode>> = {}
    for (const line of lines) patch[line.id] = { [key]: on }
    store().updateNodes(patch)
  }
  const arrowStart = shared(lines.map((l) => l.arrowStart))
  const arrowEnd = shared(lines.map((l) => l.arrowEnd))
  const pressedOf = (v: Value<boolean>) => (v === MIXED ? 'mixed' : v)

  return (
    <>
      <Header title={nodes.length === 1 ? nodes[0].name : `${nodes.length} objects`}>
        <div role="group" aria-label="Arrange" className="flex items-center gap-0.5">
          <IconButton
            label="Duplicate"
            title="Duplicate (Ctrl+D)"
            onClick={() => store().duplicate(selection)}
          >
            <CopyPlus size={18} />
          </IconButton>
          <IconButton
            label="Delete"
            title="Delete (Del)"
            danger
            onClick={() => store().deleteNodes(selection)}
          >
            <Trash2 size={18} />
          </IconButton>
          {ARRANGE.map(({ label, title, where, icon }) => (
            <IconButton
              key={where}
              label={label}
              title={title}
              onClick={() => store().reorder(selection, where)}
            >
              {icon}
            </IconButton>
          ))}
        </div>
      </Header>

      {filled.length > 0 && (
        <ColorRow
          label={filled.every((n) => n.type === 'stroke') ? 'Color' : 'Fill'}
          value={shared(filled.map((n) => n.style.fill))}
          allowNone={filled.some(canClearColor)}
          onPick={(fill, mergeKey) =>
            restyle(fill === null ? filled.filter(canClearColor) : filled, { fill }, mergeKey)
          }
        />
      )}
      {outlined.length > 0 && (
        <>
          <ColorRow
            label="Stroke"
            value={shared(outlined.map((n) => n.style.stroke))}
            allowNone={outlined.some(canClearColor)}
            onPick={(stroke, mergeKey) =>
              restyle(
                stroke === null ? outlined.filter(canClearColor) : outlined,
                { stroke },
                mergeKey,
              )
            }
          />
          <SliderRow
            label="Width"
            ariaLabel="Stroke width"
            min={MIN_SIZE}
            max={MAX_SIZE}
            value={shared(outlined.map((n) => n.style.strokeWidth))}
            disabled={outlined.every((n) => n.style.stroke === null)}
            onChange={(strokeWidth) => restyle(outlined, { strokeWidth }, 'strokeWidth')}
          />
        </>
      )}
      <SliderRow
        label="Opacity"
        ariaLabel="Opacity"
        min={0}
        max={100}
        value={shared(nodes.map((n) => Math.round(n.style.opacity * 100)))}
        format={percent}
        onChange={(n) => restyle(nodes, { opacity: n / 100 }, 'opacity')}
      />
      {rects.length > 0 && (
        <SliderRow
          label="Corners"
          ariaLabel="Corner radius"
          min={0}
          max={maxRadius}
          value={shared(rects.map(radiusOf))}
          onChange={(cornerRadius) => {
            const patch: Record<NodeId, Partial<VectorNode>> = {}
            for (const rect of rects) patch[rect.id] = { cornerRadius }
            store().updateNodes(patch, 'cornerRadius')
          }}
        />
      )}
      {lines.length > 0 && (
        <Row label="Arrows">
          <IconButton
            label="Start arrowhead"
            pressed={pressedOf(arrowStart)}
            onClick={() => setArrow('arrowStart', arrowStart !== true)}
          >
            <MoveLeft size={18} />
          </IconButton>
          <IconButton
            label="End arrowhead"
            pressed={pressedOf(arrowEnd)}
            onClick={() => setArrow('arrowEnd', arrowEnd !== true)}
          >
            <MoveRight size={18} />
          </IconButton>
        </Row>
      )}
    </>
  )
}

function BrushProperties({ eraser }: { eraser: boolean }) {
  const color = useEditorStore((s) => s.brush.color)
  const size = useEditorStore((s) => s.brush.size)
  const { setBrush } = store()
  return (
    <>
      <Header title={eraser ? 'Eraser' : 'Brush'} />
      {!eraser && (
        <ColorRow
          label="Color"
          value={color}
          allowNone={false}
          onPick={(c) => {
            if (c !== null) setBrush({ color: c })
          }}
        />
      )}
      <SliderRow
        label="Size"
        ariaLabel={eraser ? 'Eraser size' : 'Brush size'}
        min={MIN_SIZE}
        max={MAX_SIZE}
        value={size}
        onChange={(n) => setBrush({ size: n })}
      />
    </>
  )
}

const SHAPE_TITLES = { rect: 'New rectangle', ellipse: 'New ellipse', line: 'New line' }

/** The style the next shape gets; drawing one selects it, so its own style shows next. */
function ShapeDefaults({ tool }: { tool: keyof typeof SHAPE_TITLES }) {
  const shapeStyle = useEditorStore((s) => s.shapeStyle)
  const isLine = tool === 'line'
  const style = isLine ? lineStyleOf(shapeStyle) : shapeStyle
  const { setShapeStyle } = store()
  return (
    <>
      <Header title={SHAPE_TITLES[tool]} />
      {!isLine && (
        <ColorRow
          label="Fill"
          value={style.fill}
          allowNone
          onPick={(fill) => setShapeStyle({ fill })}
        />
      )}
      <ColorRow
        label="Stroke"
        value={style.stroke}
        allowNone={!isLine}
        onPick={(stroke) => setShapeStyle({ stroke })}
      />
      <SliderRow
        label="Width"
        ariaLabel="Stroke width"
        min={MIN_SIZE}
        max={MAX_SIZE}
        value={style.strokeWidth}
        disabled={style.stroke === null}
        onChange={(strokeWidth) => setShapeStyle({ strokeWidth })}
      />
      <SliderRow
        label="Opacity"
        ariaLabel="Opacity"
        min={0}
        max={100}
        value={Math.round(style.opacity * 100)}
        format={percent}
        onChange={(n) => setShapeStyle({ opacity: n / 100 })}
      />
    </>
  )
}

/**
 * Style for what the active tool works on: the selection with the select and hand tools, the
 * brush with the brush and eraser, and the next shape with the shape tools. On the right from
 * 640 px up; a bottom sheet of fixed height on phones, so the canvas doesn't jump as it changes.
 */
export function PropertiesPanel() {
  const tool = useEditorStore((s) => s.tool)
  let content: ReactNode
  if (tool === 'brush' || tool === 'eraser')
    content = <BrushProperties eraser={tool === 'eraser'} />
  else if (tool === 'rect' || tool === 'ellipse' || tool === 'line') {
    content = <ShapeDefaults tool={tool} />
  } else content = <SelectionProperties />

  return (
    <aside
      aria-label="Properties"
      className="flex h-56 shrink-0 flex-col gap-2 overflow-y-auto border-t border-neutral-200 bg-white px-4 py-2 sm:h-auto sm:w-72 sm:gap-3 sm:border-t-0 sm:border-l sm:p-3"
    >
      {content}
    </aside>
  )
}
