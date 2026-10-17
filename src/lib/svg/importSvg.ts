import svgpath from 'svgpath'
import { cubicBox, fillBox, nodeBounds, pointsBox, unionBoxes } from '../geometry/bounds'
import { KAPPA, corner, near, withKinds, type Cubic, type Xy } from '../geometry/pathData'
import { radiusUnit, solid, toBoxUnits } from '../paint/paint'
import {
  DEFAULT_SHAPE_STYLE,
  createGroupNode,
  createPathFromContours,
} from '../../store/editorStore'
import {
  DEFAULT_PAGE_HEIGHT,
  DEFAULT_PAGE_WIDTH,
  type Anchor,
  type Contour as PathContour,
  type FillRule,
  type NodeId,
  type Paint,
  type PathNode,
  type Stop,
  type VectorNode,
} from '../../types'
import { SVG_NS } from './exportSvg'

/** The page an import lands on: its size in page units. */
export interface ImportArea {
  width: number
  height: number
}

const DEFAULT_AREA: ImportArea = { width: DEFAULT_PAGE_WIDTH, height: DEFAULT_PAGE_HEIGHT }

export const NOT_AN_SVG = "This file isn't an SVG image."

/** The parts of a DOM element the importer reads, so tests can hand it a tree without a DOM. */
export interface SvgElementLike {
  readonly namespaceURI: string | null
  readonly localName: string
  readonly children: ArrayLike<SvgElementLike>
  getAttribute(name: string): string | null
}

export interface SvgImport {
  /** The group holding the import first, then everything in it, parents before children. */
  nodes: VectorNode[]
  /** The group holding the import; null when nothing could be imported. */
  groupId: NodeId | null
  /** Elements left out: text, images, styles, masks, markers and anything else unsupported. */
  skipped: number
}

const SHAPES: ReadonlySet<string> = new Set([
  'path',
  'rect',
  'circle',
  'ellipse',
  'line',
  'polyline',
  'polygon',
])
// Elements that describe a drawing rather than draw anything; leaving them out skips nothing.
const DESCRIPTIVE: ReadonlySet<string> = new Set(['title', 'desc', 'metadata'])
// Gradients are read where a fill uses them, and draw nothing themselves.
const GRADIENTS: ReadonlySet<string> = new Set(['linearGradient', 'radialGradient'])

// CSS absolute units in pixels; percentages and font-relative units aren't supported.
const UNITS: Record<string, number> = {
  '': 1,
  px: 1,
  in: 96,
  cm: 96 / 2.54,
  mm: 96 / 25.4,
  pt: 96 / 72,
  pc: 16,
}
const LENGTH = /^\s*([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)\s*(px|in|cm|mm|pt|pc)?\s*$/i

/** A length in user units (pixels); null when missing or not in an absolute unit. */
export function parseLength(value: string | null | undefined): number | null {
  const match = value == null ? null : LENGTH.exec(value)
  return match ? Number(match[1]) * UNITS[(match[2] ?? '').toLowerCase()] : null
}

interface Rgba {
  hex: string // '#rrggbb'
  alpha: number
}

const hex2 = (n: number) =>
  Math.round(Math.min(255, Math.max(0, n)))
    .toString(16)
    .padStart(2, '0')

const channel = (part: string) => (part.endsWith('%') ? parseFloat(part) * 2.55 : parseFloat(part))
const alphaOf = (part: string) => (part.endsWith('%') ? parseFloat(part) / 100 : parseFloat(part))

/** Hex and rgb() colors, read without a browser. */
function parseColorSyntax(value: string): Rgba | null {
  const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(value)
  if (hex) {
    let digits = hex[1]
    if (digits.length <= 4) digits = [...digits].map((d) => d + d).join('')
    const alpha = digits.length === 8 ? parseInt(digits.slice(6), 16) / 255 : 1
    return { hex: `#${digits.slice(0, 6)}`, alpha }
  }
  const rgb = /^rgba?\(([^)]*)\)$/.exec(value)
  if (!rgb) return null
  const parts = rgb[1].split(/[\s,/]+/).filter(Boolean)
  if (parts.length < 3 || parts.length > 4) return null
  const channels = parts.slice(0, 3).map(channel)
  const alpha = parts.length === 4 ? alphaOf(parts[3]) : 1
  if (![...channels, alpha].every(Number.isFinite)) return null
  return { hex: `#${channels.map(hex2).join('')}`, alpha }
}

let colorContext: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null | undefined

/** Any other CSS color (named, hsl() and so on), read by a canvas: none without a browser. */
function browserColor(value: string): Rgba | null {
  if (colorContext === undefined) {
    colorContext = null
    try {
      if (typeof OffscreenCanvas !== 'undefined') {
        colorContext = new OffscreenCanvas(1, 1).getContext('2d')
      } else if (typeof document !== 'undefined') {
        colorContext = document.createElement('canvas').getContext('2d')
      }
    } catch {
      colorContext = null
    }
  }
  const ctx = colorContext
  if (!ctx) return null
  // An invalid color leaves fillStyle as it was, so a valid one reads back the same both times.
  ctx.fillStyle = '#000000'
  ctx.fillStyle = value
  const first = String(ctx.fillStyle)
  ctx.fillStyle = '#ffffff'
  ctx.fillStyle = value
  return first === String(ctx.fillStyle) ? parseColorSyntax(first) : null
}

export function parseColor(value: string): Rgba | null {
  const v = value.trim().toLowerCase()
  if (v === 'transparent') return { hex: '#000000', alpha: 0 }
  return parseColorSyntax(v) ?? browserColor(v)
}

/**
 * A fill or stroke value: a hex color, null for none, or undefined when unset or unreadable, so
 * the inherited one applies. Gradients and patterns aren't supported: their fallback color, or
 * none. A color's alpha is dropped, since a node has one opacity; a clear color is none.
 */
function parsePaint(value: string | undefined, color: string): string | null | undefined {
  const v = value?.trim()
  if (v === undefined || v === '' || v === 'inherit') return undefined
  if (v === 'none') return null
  if (/^currentcolor$/i.test(v)) return color
  const url = /^url\([^)]*\)\s*(.*)$/i.exec(v)
  if (url) return parsePaint(url[1], color) ?? null
  const parsed = parseColor(v)
  if (!parsed) return undefined
  return parsed.alpha === 0 ? null : parsed.hex
}

/** A gradient a fill refers to by id, and the color to use when it can't be read. */
interface GradientRef {
  gradient: string
  fallback: string | null
}

/** A fill as the context passes it on: a color, none, or a gradient each shape lays out itself. */
type Fill = string | null | GradientRef

/** A fill value, as parsePaint reads it, except that url(#id) of a known gradient refers to it. */
function parseFill(
  value: string | undefined,
  color: string,
  gradients: ReadonlyMap<string, SvgElementLike>,
): Fill | undefined {
  const url = /^url\(\s*['"]?#([^'")\s]+)['"]?\s*\)\s*(.*)$/i.exec(value?.trim() ?? '')
  if (url && gradients.has(url[1])) {
    return { gradient: url[1], fallback: parsePaint(url[2], color) ?? null }
  }
  return parsePaint(value, color)
}

function parseOpacity(value: string | undefined): number {
  if (value === undefined) return 1
  const n = value.trim().endsWith('%') ? parseFloat(value) / 100 : parseFloat(value)
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 1
}

type Properties = (name: string) => string | undefined

/** The element's presentation properties: its style attribute's declarations over its attributes. */
function propertiesOf(el: SvgElementLike): Properties {
  const declared = new Map<string, string>()
  for (const declaration of (el.getAttribute('style') ?? '').split(';')) {
    const colon = declaration.indexOf(':')
    if (colon < 0) continue
    const name = declaration.slice(0, colon).trim().toLowerCase()
    const value = declaration
      .slice(colon + 1)
      .replace(/!\s*important/i, '')
      .trim()
    if (name && value) declared.set(name, value)
  }
  return (name) => declared.get(name) ?? el.getAttribute(name)?.trim() ?? undefined
}

/** What an element passes on to its children: inherited paint, and the transforms above it. */
interface Context {
  fill: Fill
  fillRule: FillRule
  stroke: string | null
  strokeWidth: number
  color: string
  visible: boolean
  // svgpath transform strings, applied in order: the element's own first, then its groups', then
  // the viewBox's.
  transforms: readonly string[]
}

const INITIAL_CONTEXT: Context = {
  fill: '#000000',
  fillRule: 'nonzero',
  stroke: null,
  strokeWidth: 1,
  color: '#000000',
  visible: true,
  transforms: [],
}

function contextOf(
  el: SvgElementLike,
  parent: Context,
  prop: Properties,
  gradients: ReadonlyMap<string, SvgElementLike>,
  ownTransform = true,
): Context {
  const colorValue = prop('color')
  const parsedColor =
    colorValue === undefined || /^(inherit|currentcolor)$/i.test(colorValue)
      ? null
      : parseColor(colorValue)
  const color = parsedColor?.hex ?? parent.color
  const fill = parseFill(prop('fill'), color, gradients)
  const stroke = parsePaint(prop('stroke'), color)
  const strokeWidth = parseLength(prop('stroke-width'))
  const fillRule = prop('fill-rule')
  const visibility = prop('visibility')
  const transform = ownTransform ? el.getAttribute('transform')?.trim() : undefined
  return {
    color,
    fill: fill === undefined ? parent.fill : fill,
    fillRule: fillRule === 'evenodd' || fillRule === 'nonzero' ? fillRule : parent.fillRule,
    stroke: stroke === undefined ? parent.stroke : stroke,
    strokeWidth: strokeWidth !== null && strokeWidth >= 0 ? strokeWidth : parent.strokeWidth,
    visible:
      visibility === undefined || visibility === 'inherit'
        ? parent.visible
        : visibility === 'visible',
    transforms: transform ? [transform, ...parent.transforms] : parent.transforms,
  }
}

/** The root's viewBox as [minX, minY, width, height]; null when missing or unusable. */
function viewBoxOf(root: SvgElementLike): [number, number, number, number] | null {
  const box = (root.getAttribute('viewBox') ?? '')
    .trim()
    .split(/[\s,]+/)
    .map(Number)
  if (box.length !== 4 || !box.every(Number.isFinite) || box[2] <= 0 || box[3] <= 0) return null
  return [box[0], box[1], box[2], box[3]]
}

/**
 * Whether the element is the drawing's background: a rect without an outline or a transform that
 * covers the whole viewBox (or the whole width and height without one). Simple Painter's own
 * exports start with one, and so do many others'. Imported on top of a drawing, it would hide
 * everything below, and the artboard has a background of its own.
 */
function isBackground(el: SvgElementLike, root: SvgElementLike): boolean {
  if (el.localName !== 'rect' || el.getAttribute('transform')) return false
  const prop = propertiesOf(el)
  const stroke = prop('stroke')
  if (stroke !== undefined && stroke !== 'none') return false
  const [minX, minY, w, h] = viewBoxOf(root) ?? [
    0,
    0,
    parseLength(root.getAttribute('width')) ?? NaN,
    parseLength(root.getAttribute('height')) ?? NaN,
  ]
  const x = length(el, 'x') ?? 0
  const y = length(el, 'y') ?? 0
  const reaches = (size: string | null, from: number, to: number) =>
    size?.trim() === '100%' || from + (parseLength(size) ?? -Infinity) >= to
  return (
    x <= minX &&
    y <= minY &&
    reaches(el.getAttribute('width'), x, minX + w) &&
    reaches(el.getAttribute('height'), y, minY + h)
  )
}

/**
 * The root's viewBox as a transform into its width and height (CSS pixels), centered and uniform
 * unless preserveAspectRatio is "none". Without a width or height the viewBox's units are pixels;
 * without a viewBox, nothing moves.
 */
function viewportTransform(root: SvgElementLike): string | null {
  const box = viewBoxOf(root)
  if (!box) return null
  const [minX, minY, w, h] = box
  let width = parseLength(root.getAttribute('width'))
  let height = parseLength(root.getAttribute('height'))
  if (width === null && height === null) [width, height] = [w, h]
  else if (width === null) width = (height! * w) / h
  else if (height === null) height = (width * h) / w
  if (width <= 0 || height! <= 0) return null
  let sx = width / w
  let sy = height! / h
  let tx = 0
  let ty = 0
  if (!(root.getAttribute('preserveAspectRatio') ?? '').trim().startsWith('none')) {
    sx = sy = Math.min(sx, sy)
    tx = (width - w * sx) / 2
    ty = (height! - h * sy) / 2
  }
  return `matrix(${sx} 0 0 ${sy} ${tx - minX * sx} ${ty - minY * sy})`
}

/** An affine map as SVG's matrix(a b c d e f): x' = a x + c y + e, y' = b x + d y + f. */
type Matrix = [a: number, b: number, c: number, d: number, e: number, f: number]

const IDENTITY_MATRIX: Matrix = [1, 0, 0, 1, 0, 0]

/** The transforms (svgpath transform strings, applied in order) as one matrix. */
function matrixOf(transforms: readonly string[]): Matrix {
  if (transforms.length === 0) return IDENTITY_MATRIX
  let frame = svgpath('M 0 0 L 1 0 M 0 0 L 0 1')
  for (const t of transforms) frame = frame.transform(t)
  const points: Xy[] = []
  frame.iterate((segment) => {
    if (segment[0] === 'M' || segment[0] === 'L') points.push([segment[1], segment[2]])
  })
  if (points.length < 4) return IDENTITY_MATRIX
  const [origin, x, , y] = points
  return [x[0] - origin[0], x[1] - origin[1], y[0] - origin[0], y[1] - origin[1], ...origin]
}

const mapPoint = ([a, b, c, d, e, f]: Matrix, [x, y]: Xy): Xy => [
  a * x + c * y + e,
  b * x + d * y + f,
]
const determinant = ([a, b, c, d]: Matrix) => a * d - b * c

/** How much the transforms scale areas, as a factor for lengths such as outline widths. */
function lengthScale(transforms: readonly string[]): number {
  return transforms.length === 0 ? 1 : Math.sqrt(Math.abs(determinant(matrixOf(transforms))))
}

const length = (el: SvgElementLike, name: string) => parseLength(el.getAttribute(name))

const isSvg = (el: SvgElementLike) => el.namespaceURI === SVG_NS

/** Every gradient in the tree by its id, wherever it is: in <defs> or not. */
function gradientsIn(root: SvgElementLike): Map<string, SvgElementLike> {
  const found = new Map<string, SvgElementLike>()
  const walk = (el: SvgElementLike) => {
    for (const child of Array.from(el.children)) {
      if (!isSvg(child)) continue
      const id = child.getAttribute('id')?.trim()
      if (GRADIENTS.has(child.localName) && id && !found.has(id)) found.set(id, child)
      walk(child)
    }
  }
  walk(root)
  return found
}

/** A number or a percentage as a fraction: "50%" and "0.5" are both 0.5. */
function fraction(value: string | null | undefined): number | null {
  if (value == null) return null
  const v = value.trim()
  const n = v.endsWith('%') ? parseFloat(v) / 100 : parseFloat(v)
  return Number.isFinite(n) ? n : null
}

/**
 * A gradient's stops, their offsets within 0..1 and never below an earlier stop's, as SVG reads
 * them. A stop color's alpha goes into its opacity; a color that can't be read is black.
 */
function stopsOf(gradient: SvgElementLike): Stop[] {
  let last = 0
  const stops: Stop[] = []
  for (const child of Array.from(gradient.children)) {
    if (!isSvg(child) || child.localName !== 'stop') continue
    const prop = propertiesOf(child)
    const offset = Math.max(
      last,
      Math.min(1, Math.max(0, fraction(child.getAttribute('offset')) ?? 0)),
    )
    last = offset
    const value = prop('stop-color') ?? '#000000'
    const parsed = parseColor(/^currentcolor$/i.test(value) ? (prop('color') ?? '#000000') : value)
    stops.push({
      offset,
      color: parsed?.hex ?? '#000000',
      opacity: parseOpacity(prop('stop-opacity')) * (parsed?.alpha ?? 1),
    })
  }
  return stops
}

/** A gradient and the ones it takes attributes and stops from through href, nearest first. */
function chainOf(id: string, gradients: ReadonlyMap<string, SvgElementLike>): SvgElementLike[] {
  const chain: SvgElementLike[] = []
  let next = gradients.get(id)
  while (next && !chain.includes(next) && chain.length < 16) {
    chain.push(next)
    const href = (next.getAttribute('href') ?? next.getAttribute('xlink:href'))?.trim()
    next = href?.startsWith('#') ? gradients.get(href.slice(1)) : undefined
  }
  return chain
}

/** A rectangle's outline from its top-left corner, clockwise, with quarter-ellipse corners. */
function rectData(x: number, y: number, w: number, h: number, rx: number, ry: number): string {
  if (rx <= 0 || ry <= 0) return `M ${x} ${y} H ${x + w} V ${y + h} H ${x} Z`
  const kx = KAPPA * rx
  const ky = KAPPA * ry
  const right = x + w
  const bottom = y + h
  return [
    `M ${x + rx} ${y} H ${right - rx}`,
    `C ${right - rx + kx} ${y} ${right} ${y + ry - ky} ${right} ${y + ry} V ${bottom - ry}`,
    `C ${right} ${bottom - ry + ky} ${right - rx + kx} ${bottom} ${right - rx} ${bottom} H ${x + rx}`,
    `C ${x + rx - kx} ${bottom} ${x} ${bottom - ry + ky} ${x} ${bottom - ry} V ${y + ry}`,
    `C ${x} ${y + ry - ky} ${x + rx - kx} ${y} ${x + rx} ${y} Z`,
  ].join(' ')
}

/** An ellipse as 4 quarter curves, clockwise from the right, as "Convert to path" makes it. */
function ellipseData(cx: number, cy: number, rx: number, ry: number): string {
  const kx = KAPPA * rx
  const ky = KAPPA * ry
  return [
    `M ${cx + rx} ${cy}`,
    `C ${cx + rx} ${cy + ky} ${cx + kx} ${cy + ry} ${cx} ${cy + ry}`,
    `C ${cx - kx} ${cy + ry} ${cx - rx} ${cy + ky} ${cx - rx} ${cy}`,
    `C ${cx - rx} ${cy - ky} ${cx - kx} ${cy - ry} ${cx} ${cy - ry}`,
    `C ${cx + kx} ${cy - ry} ${cx + rx} ${cy - ky} ${cx + rx} ${cy} Z`,
  ].join(' ')
}

const NUMBER = /[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?/gi

/** Path data for a basic shape; null when it draws nothing, as with a zero width. */
function shapeData(el: SvgElementLike): string | null {
  switch (el.localName) {
    case 'path':
      return el.getAttribute('d')
    case 'rect': {
      const w = length(el, 'width') ?? 0
      const h = length(el, 'height') ?? 0
      if (w <= 0 || h <= 0) return null
      // A missing or negative radius takes the other one; each stays within half its side.
      const rxValue = length(el, 'rx')
      const ryValue = length(el, 'ry')
      const rx = rxValue !== null && rxValue >= 0 ? rxValue : null
      const ry = ryValue !== null && ryValue >= 0 ? ryValue : null
      return rectData(
        length(el, 'x') ?? 0,
        length(el, 'y') ?? 0,
        w,
        h,
        Math.min(rx ?? ry ?? 0, w / 2),
        Math.min(ry ?? rx ?? 0, h / 2),
      )
    }
    case 'circle':
    case 'ellipse': {
      const r = el.localName === 'circle' ? length(el, 'r') : null
      const rxValue = r ?? length(el, 'rx')
      const ryValue = r ?? length(el, 'ry')
      const rx = rxValue ?? ryValue ?? 0
      const ry = ryValue ?? rxValue ?? 0
      if (rx <= 0 || ry <= 0) return null
      return ellipseData(length(el, 'cx') ?? 0, length(el, 'cy') ?? 0, rx, ry)
    }
    case 'line':
      return `M ${length(el, 'x1') ?? 0} ${length(el, 'y1') ?? 0} L ${length(el, 'x2') ?? 0} ${length(el, 'y2') ?? 0}`
    case 'polyline':
    case 'polygon': {
      const values = (el.getAttribute('points') ?? '').match(NUMBER)?.map(Number) ?? []
      const pairs = Math.floor(values.length / 2)
      if (pairs < 2) return null
      const points = Array.from(
        { length: pairs },
        (_, i) => `${values[2 * i]} ${values[2 * i + 1]}`,
      )
      return `M ${points.join(' L ')}${el.localName === 'polygon' ? ' Z' : ''}`
    }
    default:
      return null
  }
}

/** One subpath: where it starts, its segments as cubics, and whether it closes. */
interface Contour {
  start: Xy
  segments: Cubic[]
  closed: boolean
}

const lerp = (a: Xy, b: Xy, t: number): Xy => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]

/**
 * The subpaths of path data after the transforms, in absolute coordinates: arcs become cubics
 * (svgpath's unarc), quadratics are raised to cubics, and lines are cubics with no handles.
 */
export function contoursOf(d: string, transforms: readonly string[] = []): Contour[] {
  let path = svgpath(d).abs().unarc().unshort()
  for (const t of transforms) path = path.transform(t)
  const contours: Contour[] = []
  let open: Contour | null = null
  path.iterate((segment, _index, x, y) => {
    const from: Xy = [x, y]
    const add = (cubic: Cubic) => {
      // Drawing on after a Z starts a new subpath where the last one started.
      if (!open) {
        open = { start: from, segments: [], closed: false }
        contours.push(open)
      }
      open.segments.push(cubic)
    }
    const straight = (to: Xy) => add([from, from, to, to])
    switch (segment[0]) {
      case 'M':
        open = { start: [segment[1], segment[2]], segments: [], closed: false }
        contours.push(open)
        break
      case 'L':
        straight([segment[1], segment[2]])
        break
      case 'H':
        straight([segment[1], y])
        break
      case 'V':
        straight([x, segment[1]])
        break
      case 'C':
        add([from, [segment[1], segment[2]], [segment[3], segment[4]], [segment[5], segment[6]]])
        break
      case 'Q': {
        const control: Xy = [segment[1], segment[2]]
        const to: Xy = [segment[3], segment[4]]
        add([from, lerp(from, control, 2 / 3), lerp(to, control, 2 / 3), to])
        break
      }
      case 'Z':
      case 'z':
        if (open) open.closed = true
        open = null
        break
    }
  })
  return contours
}

const isDot = ([p0, p1, p2, p3]: Cubic) => near(p0, p1) && near(p0, p2) && near(p0, p3)

/**
 * A subpath as path anchors in canvas units; null when it draws nothing. Segments of no length
 * are dropped, and a closed subpath that ends where it started closes on its first anchor.
 */
export function contourAnchors({ start, segments, closed }: Contour): Anchor[] | null {
  const kept = segments.filter((segment) => !isDot(segment))
  if (kept.length === 0) return null
  const anchors: Anchor[] = [corner(start[0], start[1])]
  for (const [, out, into, end] of kept) {
    const last = anchors[anchors.length - 1]
    last.outX = out[0] - last.x
    last.outY = out[1] - last.y
    anchors.push({
      ...corner(end[0], end[1]),
      inX: into[0] - end[0],
      inY: into[1] - end[1],
    })
  }
  const first = anchors[0]
  const last = anchors[anchors.length - 1]
  if (closed && anchors.length > 2 && near([first.x, first.y], [last.x, last.y])) {
    first.inX = last.inX
    first.inY = last.inY
    anchors.pop()
  }
  return withKinds(anchors, closed)
}

const round3 = (n: number) => Math.round(n * 1000) / 1000 || 0
const round6 = (n: number) => Math.round(n * 1e6) / 1e6 || 0

/**
 * Places the import on the page: when it is larger, scaled down to fit and centered; when it lies
 * even partly off the page, centered; otherwise where it is. The scale is baked into the paths'
 * anchors and outline widths, so the groups keep a scale of 1 and the drawing keeps its look.
 * Coordinates are rounded to thousandths.
 */
function placeOnPage(nodes: Map<NodeId, VectorNode>, group: VectorNode, area: ImportArea): void {
  const box = nodeBounds(group, Object.fromEntries(nodes))
  let s = 1
  let dx = 0
  let dy = 0
  if (box) {
    const w = box.maxX - box.minX
    const h = box.maxY - box.minY
    s = Math.min(1, area.width / w, area.height / h)
    const inside =
      box.minX >= 0 && box.minY >= 0 && box.maxX <= area.width && box.maxY <= area.height
    if (s < 1 || !inside) {
      dx = area.width / 2 - (s * (box.minX + box.maxX)) / 2
      dy = area.height / 2 - (s * (box.minY + box.maxY)) / 2
    }
  }
  for (const [id, node] of nodes) {
    if (node.type !== 'path') continue
    const { transform, style } = node
    nodes.set(id, {
      ...node,
      transform: { ...transform, x: round3(s * transform.x + dx), y: round3(s * transform.y + dy) },
      style:
        style.stroke === null ? style : { ...style, strokeWidth: round3(style.strokeWidth * s) },
      contours: node.contours.map((c) => ({
        ...c,
        anchors: c.anchors.map((a) => ({
          ...a,
          x: round3(a.x * s),
          y: round3(a.y * s),
          inX: round3(a.inX * s),
          inY: round3(a.inY * s),
          outX: round3(a.outX * s),
          outY: round3(a.outY * s),
        })),
      })),
    })
  }
}

/**
 * Turns a parsed SVG into nodes: every supported shape becomes a path node with a contour per
 * subpath and the shape's fill rule, its transforms baked into its anchors; <g> elements become
 * groups. Everything lands in one new group named `name`, placed on a page of `area`'s size by
 * placeOnPage.
 * Fill, stroke, stroke-width, opacity, color, display and visibility are read from attributes and
 * inline styles. Text, images, <use>, <style>, gradients, masks and other unsupported elements are
 * counted as skipped; so is everything in <defs>, which only other elements use. A background
 * rect (isBackground) is left out without counting.
 */
export function importSvgElement(
  root: SvgElementLike,
  name = 'Imported SVG',
  area: ImportArea = DEFAULT_AREA,
): SvgImport {
  const nodes = new Map<NodeId, VectorNode>()
  let skipped = 0

  const gradients = gradientsIn(root)

  const skipAll = (el: SvgElementLike) => {
    for (const child of Array.from(el.children)) {
      if (isSvg(child) && !DESCRIPTIVE.has(child.localName) && !GRADIENTS.has(child.localName)) {
        skipped += 1
      }
    }
  }

  /** A group of `children` with the given opacity, adopting them. */
  const groupOf = (children: VectorNode[], opacity: number): VectorNode => {
    const group = createGroupNode(children.map((child) => child.id))
    group.style.opacity = opacity
    for (const child of children) child.parentId = group.id
    nodes.set(group.id, group)
    return group
  }

  // What percentages in userSpaceOnUse gradients are of: the viewBox, or else the svg's size.
  const viewBox = viewBoxOf(root)
  const viewWidth = viewBox?.[2] ?? parseLength(root.getAttribute('width')) ?? area.width
  const viewHeight = viewBox?.[3] ?? parseLength(root.getAttribute('height')) ?? area.height

  /**
   * A gradient fill laid out on a new path node, in units of the node's fill box. The gradient's
   * coordinates go through its gradientTransform, the shape's own box for objectBoundingBox and
   * the transforms the path's anchors were baked with. A linear gradient maps exactly under any
   * of them: its start is mapped, and its direction goes through the inverse transpose, so its
   * color bands keep their angle. A radial gradient's radius scales by √|det|, and one whose
   * gradientTransform turns or skews it is painted with its first stop instead. No stops is no
   * fill and one stop a solid fill; the focal point and spreadMethod aren't read.
   */
  const gradientFill = (
    ref: GradientRef,
    own: string,
    ctx: Context,
    node: PathNode,
  ): Paint | null => {
    const chain = chainOf(ref.gradient, gradients)
    if (chain.length === 0) return ref.fallback === null ? null : solid(ref.fallback)
    const stops = chain.map(stopsOf).find((list) => list.length > 0) ?? []
    if (stops.length === 0) return null
    const firstStop = solid(stops[0].color)
    const lastStop = solid(stops[stops.length - 1].color)
    if (stops.length === 1) return firstStop
    const linear = chain[0].localName === 'linearGradient'
    const tag = chain[0].localName
    // An attribute from the nearest gradient that has it; geometry only from gradients of a kind.
    const attr = (name: string, only?: string) =>
      chain
        .filter((g) => only === undefined || g.localName === only)
        .map((g) => g.getAttribute(name))
        .find((v) => v !== null)
        ?.trim() ?? null
    const userSpace = attr('gradientUnits') === 'userSpaceOnUse'
    const gradientTransform = attr('gradientTransform')
    const transforms: string[] = gradientTransform ? [gradientTransform] : []
    if (!userSpace) {
      const shape = unionBoxes(
        contoursOf(own).map(({ start, segments }) =>
          unionBoxes([pointsBox([start]), ...segments.map(cubicBox)]),
        ),
      )
      const w = shape ? shape.maxX - shape.minX : 0
      const h = shape ? shape.maxY - shape.minY : 0
      // SVG leaves out a bounding-box gradient on a shape without width or height.
      if (!shape || w <= 0 || h <= 0) return firstStop
      transforms.push(`matrix(${w} 0 0 ${h} ${shape.minX} ${shape.minY})`)
    }
    const m = matrixOf([...transforms, ...ctx.transforms])
    const det = determinant(m)
    const box = fillBox(node)
    if (!(Math.abs(det) > 1e-12) || !box) return firstStop

    const coord = (name: string, fallback: string, size: number) => {
      const raw = attr(name, tag) ?? fallback
      if (raw.endsWith('%')) return (parseFloat(raw) / 100) * (userSpace ? size : 1)
      return (userSpace ? parseLength(raw) : fraction(raw)) ?? 0
    }
    // From the shape's coordinates, which the anchors were made in, to the node's box units.
    const inBox = ([x, y]: Xy): Xy => {
      const [u, v] = toBoxUnits(box, [x - node.transform.x, y - node.transform.y])
      return [round6(u), round6(v)]
    }

    if (linear) {
      const start: Xy = [coord('x1', '0%', viewWidth), coord('y1', '0%', viewHeight)]
      const end: Xy = [coord('x2', '100%', viewWidth), coord('y2', '0%', viewHeight)]
      const v: Xy = [end[0] - start[0], end[1] - start[1]]
      const length2 = v[0] * v[0] + v[1] * v[1]
      // A gradient without length is painted with its last stop.
      if (!(length2 > 0)) return lastStop
      const [a, b, c, d] = m
      // The direction the colors change along, mapped by the inverse transpose.
      const u: Xy = [(d * v[0] - b * v[1]) / det, (a * v[1] - c * v[0]) / det]
      const k = length2 / (u[0] * u[0] + u[1] * u[1])
      const [sx, sy] = mapPoint(m, start)
      return {
        kind: 'linear',
        stops,
        start: inBox([sx, sy]),
        end: inBox([sx + u[0] * k, sy + u[1] * k]),
      }
    }
    if (gradientTransform) {
      const [, b, c] = matrixOf([gradientTransform])
      if (Math.abs(b) > 1e-9 || Math.abs(c) > 1e-9) return firstStop
    }
    const center: Xy = [coord('cx', '50%', viewWidth), coord('cy', '50%', viewHeight)]
    const r = coord('r', '50%', Math.hypot(viewWidth, viewHeight) / Math.SQRT2)
    if (!(r > 0)) return lastStop
    return {
      kind: 'radial',
      stops,
      center: inBox(mapPoint(m, center)),
      radius: round6((r * Math.sqrt(Math.abs(det))) / radiusUnit(box)),
    }
  }

  /** The shape as a path node of its subpaths, in canvas units; none when it draws nothing. */
  const shapeNodes = (el: SvgElementLike, ctx: Context): PathNode[] => {
    const d = shapeData(el)
    if (!d) return []
    // A line has no inside to fill.
    const fill = el.localName === 'line' ? null : ctx.fill
    const width = ctx.stroke === null ? 0 : ctx.strokeWidth * lengthScale(ctx.transforms)
    const stroke = width > 0 ? ctx.stroke : null
    if (fill === null && stroke === null) return []
    // Without an outline, the width is the one a new shape's outline starts with.
    const strokeWidth = stroke === null ? DEFAULT_SHAPE_STYLE.strokeWidth : width
    const contours = contoursOf(d, ctx.transforms).flatMap((contour): PathContour[] => {
      const anchors = contourAnchors(contour)
      return anchors ? [{ anchors, closed: contour.closed }] : []
    })
    if (contours.length === 0) return []
    const node = createPathFromContours(
      contours,
      { fill: null, stroke, strokeWidth, opacity: 1 },
      ctx.fillRule,
    )
    node.style.fill =
      fill === null
        ? null
        : typeof fill === 'string'
          ? solid(fill)
          : gradientFill(fill, d, ctx, node)
    if (node.style.fill === null && stroke === null) return []
    return [node]
  }

  /** The nodes an element makes, for its parent to adopt. */
  const visit = (el: SvgElementLike, parent: Context): VectorNode[] => {
    // Editors' own elements, such as Inkscape's, aren't in the SVG namespace.
    if (el.namespaceURI !== SVG_NS || DESCRIPTIVE.has(el.localName)) return []
    if (el.localName === 'defs') {
      skipAll(el)
      return []
    }
    if (GRADIENTS.has(el.localName)) return []
    const isGroup = el.localName === 'g'
    if (!isGroup && !SHAPES.has(el.localName)) {
      skipped += 1
      return []
    }
    const prop = propertiesOf(el)
    if (prop('display') === 'none') return []
    const ctx = contextOf(el, parent, prop, gradients)
    const opacity = parseOpacity(prop('opacity'))
    const made: VectorNode[] = isGroup
      ? Array.from(el.children).flatMap((child) => visit(child, ctx))
      : ctx.visible
        ? shapeNodes(el, ctx)
        : []
    if (made.length === 0) return []
    if (!isGroup && made.length === 1) {
      const [node] = made
      node.style.opacity = opacity
      nodes.set(node.id, node)
      return made
    }
    for (const node of made) nodes.set(node.id, node)
    return [groupOf(made, opacity)]
  }

  const rootProps = propertiesOf(root)
  const viewport = viewportTransform(root)
  const base: Context = { ...INITIAL_CONTEXT, transforms: viewport ? [viewport] : [] }
  const ctx = contextOf(root, base, rootProps, gradients, false)
  const children = Array.from(root.children)
  // A background can only be the first thing drawn.
  const first = children.find(
    (child) =>
      child.namespaceURI === SVG_NS &&
      !DESCRIPTIVE.has(child.localName) &&
      child.localName !== 'defs',
  )
  const top = children
    .filter((child) => child !== first || !isBackground(child, root))
    .flatMap((child) => visit(child, ctx))
  if (top.length === 0) return { nodes: [], groupId: null, skipped }

  const group = groupOf(top, parseOpacity(rootProps('opacity')))
  group.name = name
  placeOnPage(nodes, group, area)

  // Parents before their children, as the doc's tree walks them.
  const ordered: VectorNode[] = []
  const collect = (id: NodeId) => {
    const node = nodes.get(id)
    if (!node) return
    ordered.push(node)
    if (node.type === 'group') node.childIds.forEach(collect)
  }
  collect(group.id)
  return { nodes: ordered, groupId: group.id, skipped }
}

/** Parses SVG text and imports it as importSvgElement does; throws NOT_AN_SVG when it isn't one. */
export function importSvg(text: string, name?: string, area?: ImportArea): SvgImport {
  const parsed = new DOMParser().parseFromString(text, 'image/svg+xml')
  const root = parsed.documentElement
  if (
    parsed.getElementsByTagName('parsererror').length > 0 ||
    root.namespaceURI !== SVG_NS ||
    root.localName !== 'svg'
  ) {
    throw new Error(NOT_AN_SVG)
  }
  return importSvgElement(root, name, area)
}
