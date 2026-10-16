import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  ArrowDown,
  ArrowUp,
  Bold,
  BringToFront,
  Check,
  CopyPlus,
  Group,
  Italic,
  MoveLeft,
  MoveRight,
  PencilLine,
  SendToBack,
  Spline,
  Trash2,
  Ungroup,
} from 'lucide-react'
import type { ReactNode } from 'react'
import type { AnchorKind } from '../lib/geometry/pathData'
import { WEB_SAFE_FONTS } from '../lib/geometry/textLayout'
import {
  MAX_FONT_SIZE,
  MAX_SIZE,
  MIN_FONT_SIZE,
  MIN_SIZE,
  canConvertToPath,
  useEditorStore,
  type ZOrder,
} from '../store/editorStore'
import { activeAnchorOf, deleteActiveAnchor, setActiveAnchorKind } from '../tools/directTool'
import { finishPath } from '../tools/penTool'
import { ungroupSelection } from '../tools/selectTool'
import { lineStyleOf } from '../tools/shapeTools'
import { startTextEdit } from '../tools/textTool'
import type { NodeId, NodeOf, Style, TextNode, VectorNode } from '../types'
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

// Which style each node type has: freehand strokes and text are all fill and lines all outline,
// so none of them can do without its color. Rectangles, ellipses and paths can do without either.
// Groups only have their opacity.
const canClearColor = (n: VectorNode) =>
  n.type === 'rect' || n.type === 'ellipse' || n.type === 'path'
const hasFill = (n: VectorNode) => n.type === 'stroke' || n.type === 'text' || canClearColor(n)
const hasOutline = (n: VectorNode) => n.type === 'line' || canClearColor(n)

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

const ANCHOR_KINDS: { kind: AnchorKind; label: string; title: string }[] = [
  { kind: 'corner', label: 'Corner', title: 'Corner: handles move on their own' },
  { kind: 'smooth', label: 'Smooth', title: 'Smooth: handles stay in line' },
  { kind: 'symmetric', label: 'Symmetric', title: 'Symmetric: handles stay in line and equal' },
]

/** Direct select's active anchor: its kind, and a delete button for touch screens. */
function AnchorRow() {
  const kind = useEditorStore((s) => {
    const active = activeAnchorOf(s)
    return active ? active.path.anchors[active.index].kind : null
  })
  if (kind === null) return null
  return (
    <Row label="Anchor">
      <div role="group" aria-label="Anchor kind" className="flex items-center gap-0.5">
        {ANCHOR_KINDS.map((option) => (
          <button
            key={option.kind}
            type="button"
            aria-pressed={kind === option.kind}
            title={option.title}
            onClick={() => setActiveAnchorKind(option.kind)}
            className={`h-8 rounded-md px-2 text-xs transition-colors ${
              kind === option.kind
                ? 'bg-sky-100 text-sky-700'
                : 'text-neutral-700 hover:bg-neutral-100'
            }`}
          >
            {option.label}
          </button>
        ))}
      </div>
      <IconButton
        label="Delete anchor"
        title="Delete anchor (Del)"
        danger
        onClick={deleteActiveAnchor}
      >
        <Trash2 size={18} />
      </IconButton>
    </Row>
  )
}

type FontStyle = TextNode['fontStyle']
type Align = TextNode['align']

const isBold = (s: FontStyle) => s.includes('bold')
const isItalic = (s: FontStyle) => s.includes('italic')
const fontStyleOf = (bold: boolean, italic: boolean): FontStyle =>
  bold && italic ? 'bold italic' : bold ? 'bold' : italic ? 'italic' : 'normal'

const ALIGNS: { align: Align; label: string; icon: ReactNode }[] = [
  { align: 'left', label: 'Align left', icon: <AlignLeft size={18} /> },
  { align: 'center', label: 'Align center', icon: <AlignCenter size={18} /> },
  { align: 'right', label: 'Align right', icon: <AlignRight size={18} /> },
]

interface TextRowsProps {
  family: Value<string>
  size: Value<number>
  fontStyle: Value<FontStyle>[] // one per text, so bold and italic can each be mixed
  align: Value<Align>
  onFamily(family: string): void
  onSize(size: number): void
  onFontStyle(change: (current: FontStyle) => FontStyle): void
  onAlign(align: Align): void
}

/** Font, size, bold and italic, and alignment: for selected text and for new text. */
function TextRows({
  family,
  size,
  fontStyle,
  align,
  onFamily,
  onSize,
  onFontStyle,
  onAlign,
}: TextRowsProps) {
  const styles = fontStyle.filter((s): s is FontStyle => s !== MIXED)
  const bold = shared(styles.map(isBold))
  const italic = shared(styles.map(isItalic))
  const pressedOf = (v: Value<boolean>) => (v === MIXED ? 'mixed' : v)
  // A family that isn't offered, from an older drawing, still shows as itself.
  const known = family === MIXED || WEB_SAFE_FONTS.some((f) => f.family === family)
  return (
    <>
      <Row label="Font" mixed={family === MIXED}>
        <select
          aria-label="Font"
          value={family === MIXED ? '' : family}
          onChange={(e) => onFamily(e.target.value)}
          className="h-8 min-w-0 flex-1 rounded-md border border-neutral-300 bg-white px-1 text-sm text-neutral-800"
        >
          {family === MIXED && (
            <option value="" disabled>
              Mixed
            </option>
          )}
          {!known && <option value={family}>{family.split(',')[0]}</option>}
          {WEB_SAFE_FONTS.map((f) => (
            <option key={f.family} value={f.family} style={{ fontFamily: f.family }}>
              {f.label}
            </option>
          ))}
        </select>
      </Row>
      <SliderRow
        label="Size"
        ariaLabel="Font size"
        min={MIN_FONT_SIZE}
        max={MAX_FONT_SIZE}
        value={size === MIXED ? MIXED : Math.round(size)}
        onChange={onSize}
      />
      <Row label="Style">
        <IconButton
          label="Bold"
          pressed={pressedOf(bold)}
          onClick={() => onFontStyle((s) => fontStyleOf(bold !== true, isItalic(s)))}
        >
          <Bold size={18} />
        </IconButton>
        <IconButton
          label="Italic"
          pressed={pressedOf(italic)}
          onClick={() => onFontStyle((s) => fontStyleOf(isBold(s), italic !== true))}
        >
          <Italic size={18} />
        </IconButton>
        <div aria-hidden className="mx-1 h-6 w-px bg-neutral-200" />
        {ALIGNS.map((option) => (
          <IconButton
            key={option.align}
            label={option.label}
            pressed={align === option.align}
            onClick={() => onAlign(option.align)}
          >
            {option.icon}
          </IconButton>
        ))}
      </Row>
    </>
  )
}

/** Text rows for the selected texts; each change is one undo step, a slider drag included. */
function SelectedTextRows({ texts }: { texts: TextNode[] }) {
  const apply = (change: (t: TextNode) => Partial<TextNode>, mergeKey?: string) => {
    const patch: Record<NodeId, Partial<VectorNode>> = {}
    for (const text of texts) {
      const changes = change(text)
      const same = (Object.keys(changes) as (keyof TextNode)[]).every((k) => changes[k] === text[k])
      if (!same) patch[text.id] = changes
    }
    if (Object.keys(patch).length > 0) store().updateNodes(patch, mergeKey)
  }
  return (
    <TextRows
      family={shared(texts.map((t) => t.fontFamily))}
      size={shared(texts.map((t) => Math.round(t.fontSize)))}
      fontStyle={texts.map((t) => t.fontStyle)}
      align={shared(texts.map((t) => t.align))}
      onFamily={(fontFamily) => apply(() => ({ fontFamily }))}
      onSize={(fontSize) => apply(() => ({ fontSize }), 'fontSize')}
      onFontStyle={(change) => apply((t) => ({ fontStyle: change(t.fontStyle) }))}
      onAlign={(align) => apply(() => ({ align }))}
    />
  )
}

function SelectionProperties() {
  const doc = useEditorStore((s) => s.doc)
  const selection = useEditorStore((s) => s.selection)
  const direct = useEditorStore((s) => s.tool === 'direct')
  const nodes = selection.flatMap((id) => (id in doc.nodes ? [doc.nodes[id]] : []))

  if (nodes.length === 0) {
    return (
      <>
        <Header title="Nothing selected" />
        <p className="text-xs text-neutral-500">
          {direct
            ? 'Tap or click a path to edit its anchors and handles. Double-click its outline to add an anchor.'
            : 'Tap or click an object to change its style. Drag across empty canvas to select several.'}
        </p>
      </>
    )
  }

  const filled = nodes.filter(hasFill)
  const outlined = nodes.filter(hasOutline)
  const rects = nodes.filter((n): n is NodeOf<'rect'> => n.type === 'rect')
  const convertible = nodes.filter((n) => canConvertToPath(n) && !n.locked)
  const lines = nodes.filter((n): n is NodeOf<'line'> => n.type === 'line')
  const texts = nodes.filter((n): n is TextNode => n.type === 'text')
  const hasGroup = nodes.some((n) => n.type === 'group')
  const colorOnly = filled.every((n) => n.type === 'stroke' || n.type === 'text')
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
        <div role="group" aria-label="Arrange" className="flex flex-wrap items-center gap-0.5">
          {texts.length === 1 && nodes.length === 1 && (
            <IconButton
              label="Edit text"
              title="Edit text (Enter, or double-click)"
              onClick={() => startTextEdit(texts[0].id)}
            >
              <PencilLine size={18} />
            </IconButton>
          )}
          <IconButton label="Group" title="Group (Ctrl+G)" onClick={() => store().group(selection)}>
            <Group size={18} />
          </IconButton>
          {hasGroup && (
            <IconButton label="Ungroup" title="Ungroup (Ctrl+Shift+G)" onClick={ungroupSelection}>
              <Ungroup size={18} />
            </IconButton>
          )}
          {convertible.length > 0 && (
            <IconButton
              label="Convert to path"
              onClick={() => store().convertToPath(convertible.map((n) => n.id))}
            >
              <Spline size={18} />
            </IconButton>
          )}
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

      {direct && <AnchorRow />}
      {filled.length > 0 && (
        <ColorRow
          label={colorOnly ? 'Color' : 'Fill'}
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
      {texts.length > 0 && <SelectedTextRows texts={texts} />}
    </>
  )
}

/** The color and font the next text gets; placing one selects it, so its own show next. */
function TextDefaults() {
  const textStyle = useEditorStore((s) => s.textStyle)
  const { setTextStyle } = store()
  return (
    <>
      <Header title="New text" />
      <ColorRow
        label="Color"
        value={textStyle.fill}
        allowNone={false}
        onPick={(fill) => {
          if (fill !== null) setTextStyle({ fill })
        }}
      />
      <TextRows
        family={textStyle.fontFamily}
        size={textStyle.fontSize}
        fontStyle={[textStyle.fontStyle]}
        align={textStyle.align}
        onFamily={(fontFamily) => setTextStyle({ fontFamily })}
        onSize={(fontSize) => setTextStyle({ fontSize })}
        onFontStyle={(change) => setTextStyle({ fontStyle: change(textStyle.fontStyle) })}
        onAlign={(align) => setTextStyle({ align })}
      />
      <p className="text-xs text-neutral-500">
        Tap or click to place a text, or drag to set its width.
      </p>
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

const SHAPE_TITLES = {
  rect: 'New rectangle',
  ellipse: 'New ellipse',
  line: 'New line',
  pen: 'New path',
}

/**
 * The style the next shape or path gets; drawing one selects it, so its own style shows next. The
 * pen also gets a button that ends the path, for touch screens.
 */
function ShapeDefaults({ tool }: { tool: keyof typeof SHAPE_TITLES }) {
  const shapeStyle = useEditorStore((s) => s.shapeStyle)
  const canFinish = useEditorStore((s) => s.draft?.type === 'path' && s.draft.anchors.length >= 2)
  const isLine = tool === 'line'
  const style = isLine ? lineStyleOf(shapeStyle) : shapeStyle
  const { setShapeStyle } = store()
  return (
    <>
      <Header title={SHAPE_TITLES[tool]}>
        {tool === 'pen' && (
          <IconButton
            label="Finish path"
            title="Finish path (Enter)"
            disabled={!canFinish}
            onClick={finishPath}
          >
            <Check size={18} />
          </IconButton>
        )}
      </Header>
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
 * Style for what the active tool works on: the selection with the select, direct-select and hand
 * tools, the brush with the brush and eraser, the next shape with the shape tools and the pen,
 * and the next text with the text tool, or the text being edited. App places it: above the
 * layers on the right from 640 px up, a tab of the bottom sheet on phones.
 */
export function PropertiesPanel({ className = '' }: { className?: string }) {
  const tool = useEditorStore((s) => s.tool)
  const editing = useEditorStore((s) => s.editingText !== null)
  let content: ReactNode
  if (tool === 'brush' || tool === 'eraser')
    content = <BrushProperties eraser={tool === 'eraser'} />
  else if (tool === 'rect' || tool === 'ellipse' || tool === 'line' || tool === 'pen') {
    content = <ShapeDefaults tool={tool} />
  } else if (tool === 'text' && !editing) content = <TextDefaults />
  else content = <SelectionProperties />

  return (
    <aside
      aria-label="Properties"
      className={`flex min-h-0 flex-col gap-2 overflow-y-auto px-4 py-2 sm:gap-3 sm:p-3 ${className}`}
    >
      {content}
    </aside>
  )
}
