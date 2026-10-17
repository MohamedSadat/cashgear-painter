import { arrowHeadSize, fillBox } from '../geometry/bounds'
import { IMAGE_PLACEHOLDER_COLOR } from '../images/assetRefs'
import { cachedPathData } from '../geometry/pathData'
import { TEXT_LINE_HEIGHT, firstBaseline, quoteFamilies, textLines } from '../geometry/textLayout'
import { pageById } from '../pages'
import { isGradient, lastStop, placeGradient, type PaintBox } from '../paint/paint'
import { pageBox } from '../paint/toKonva'
import { cachedStrokePath } from '../strokePath'
import type {
  AssetMeta,
  Doc,
  ImageNode,
  NodeOf,
  Paint,
  ShapeNode,
  Stop,
  TextNode,
  Transform,
  VectorNode,
} from '../../types'

export const SVG_FILE_NAME = 'drawing.svg'
export const SVG_NS = 'http://www.w3.org/2000/svg'
export const XLINK_NS = 'http://www.w3.org/1999/xlink'

/** An image's bytes as a URL an SVG can hold, such as a data: URL; null when there are none. */
export type ImageHref = (asset: AssetMeta) => string | null

/** The font-family an SVG text is written with, from the text's font stack. */
export type FontFamilyOf = (stack: string) => string

/** A picture of a node in its own coordinates, written in its place (see SvgOptions). */
export interface NodeImage {
  href: string
  x: number
  y: number
  width: number
  height: number
}

export interface SvgOptions {
  // Without it, or without bytes for an asset, an image is the gray box the canvas shows while
  // it loads.
  imageHref?: ImageHref
  // The text's own stack by default; the PDF export names the font it draws the text with.
  fontFamily?: FontFamilyOf
  // Put before every id in <defs>, so SVGs drawn into one PDF don't share ids.
  idPrefix?: string
  // A picture to write in place of a node, or null for the node itself. The PDF export pictures
  // what svg2pdf.js can't draw. A text stays on top of its picture, invisible but selectable.
  nodeImage?(node: VectorNode): NodeImage | null
  // A gradient-filled shape's outline as an element of its own over the fill: jsPDF clips to the
  // shape and strokes before it paints a gradient, which hides the inner half of the outline.
  outlineApart?: boolean
}

const ownFamily: FontFamilyOf = (stack) => quoteFamilies(stack).replaceAll('"', "'")

/** n rounded to `digits` decimals, without a trailing '.0' or a '-0'. */
function num(n: number, digits = 3): string {
  const factor = 10 ** digits
  const rounded = Math.round(n * factor) / factor
  return rounded === 0 ? '0' : String(rounded)
}

const XML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
}

// Control characters other than tab and newline aren't allowed in XML 1.0 at all.
// eslint-disable-next-line no-control-regex
const NOT_XML = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g

function escapeXml(text: string): string {
  return text.replace(NOT_XML, '').replace(/[&<>"]/g, (c) => XML_ESCAPES[c])
}

type AttrValue = string | number | null | undefined
type Attrs = Record<string, AttrValue>

/** ` name="value"` for each attribute that has a value; numbers keep 3 decimals. */
function attrs(list: Attrs): string {
  let out = ''
  for (const [name, value] of Object.entries(list)) {
    if (value === null || value === undefined) continue
    out += ` ${name}="${typeof value === 'number' ? num(value) : escapeXml(value)}"`
  }
  return out
}

/**
 * The node's transform in Konva's order, which SVG reads right to left: scale, then rotate, then
 * translate. Parts that change nothing are left out; null for no transform at all.
 */
export function transformAttr(t: Transform): string | null {
  const parts: string[] = []
  if (t.x !== 0 || t.y !== 0) parts.push(`translate(${num(t.x)} ${num(t.y)})`)
  // Finer than positions: a turn or a scale is multiplied by distances up to the artboard's size.
  if (t.rotation !== 0) parts.push(`rotate(${num(t.rotation, 4)})`)
  if (t.scaleX !== 1 || t.scaleY !== 1) {
    parts.push(`scale(${num(t.scaleX, 6)} ${num(t.scaleY, 6)})`)
  }
  return parts.length > 0 ? parts.join(' ') : null
}

/** Arrowhead markers, one per color, width and end, written into <defs>. */
class Markers {
  private ids = new Map<string, string>()
  readonly defs: string[] = []

  private readonly prefix: string

  constructor(prefix: string) {
    this.prefix = prefix
  }

  /**
   * A marker drawn as Konva draws an arrowhead: a triangle `arrowHeadSize` long and wide with its
   * tip on the line's end, filled and outlined in the line's color with round joins. A start
   * marker points backwards, so plain orient="auto" serves both ends. It is in units of the line's
   * width (markerUnits' default), which svg2pdf.js assumes whatever markerUnits says, with a
   * viewBox around the triangle and its outline, which svg2pdf.js clips to.
   */
  id(color: string, width: number, end: 'start' | 'end'): string {
    const key = `${color} ${width} ${end}`
    let id = this.ids.get(key)
    if (id !== undefined) return id
    id = `${this.prefix}arrow-${end}-${this.ids.size + 1}`
    this.ids.set(key, id)
    const unit = Math.max(width, 0.01)
    const head = arrowHeadSize(width) / unit
    const back = end === 'end' ? -head : head
    const d = `M 0 0 L ${num(back, 4)} ${num(head / 2, 4)} L ${num(back, 4)} ${num(-head / 2, 4)} Z`
    // The outline, one unit wide, reaches half a unit past the triangle.
    const box = [Math.min(0, back) - 0.5, -head / 2 - 0.5, head + 1, head + 1].map((n) => num(n, 4))
    this.defs.push(
      `<marker${attrs({ id, viewBox: box.join(' '), markerWidth: box[2], markerHeight: box[3], orient: 'auto', style: 'overflow:visible' })}>` +
        `<path${attrs({ d, fill: color, stroke: color, 'stroke-width': 1, 'stroke-linejoin': 'round' })}/>` +
        '</marker>',
    )
    return id
  }
}

/**
 * Gradient fills, written into <defs> as <linearGradient> and <radialGradient>, one per distinct
 * gradient as placed. They use userSpaceOnUse in the pixels of the element's own coordinates,
 * which is where Konva lays them out too: objectBoundingBox would stretch a radial gradient into
 * an ellipse on a box that isn't square.
 */
class Gradients {
  private ids = new Map<string, string>()
  readonly defs: string[] = []

  private readonly prefix: string

  constructor(prefix: string) {
    this.prefix = prefix
  }

  /** The fill attributes for a paint laid out in `box`, the element's fill box. */
  fill(paint: Paint | null, box: () => PaintBox | null): Attrs {
    if (paint === null) return { fill: 'none' }
    if (paint.kind === 'solid') return { fill: paint.color }
    const area = box()
    const placed = area && placeGradient(paint, area)
    // Without extent or a box, the one color Konva paints: see toKonvaFill.
    if (!placed) return solidStop(area ? lastStop(paint) : paint.stops[0])
    const stops = placed.stops.map(
      (stop) =>
        `<stop${attrs({ offset: stop.offset, 'stop-color': stop.color, 'stop-opacity': stop.opacity < 1 ? stop.opacity : undefined })}/>`,
    )
    const geometry: Attrs =
      placed.kind === 'linear'
        ? { x1: placed.start[0], y1: placed.start[1], x2: placed.end[0], y2: placed.end[1] }
        : { cx: placed.center[0], cy: placed.center[1], r: placed.radius }
    const tag = placed.kind === 'linear' ? 'linearGradient' : 'radialGradient'
    const body = `${attrs({ gradientUnits: 'userSpaceOnUse', ...geometry })}>${stops.join('')}</${tag}>`
    let id = this.ids.get(tag + body)
    if (id === undefined) {
      id = `${this.prefix}gradient-${this.ids.size + 1}`
      this.ids.set(tag + body, id)
      this.defs.push(`<${tag}${attrs({ id })}${body}`)
    }
    return { fill: `url(#${id})` }
  }
}

/** One stop as a plain fill, its opacity as fill-opacity. */
const solidStop = (stop: Stop): Attrs => ({
  fill: stop.color,
  'fill-opacity': stop.opacity < 1 ? Math.max(0, stop.opacity) : undefined,
})

/** What nodeSvg passes down: the defs it fills as it goes, and how to find images' bytes. */
interface Defs {
  markers: Markers
  gradients: Gradients
  imageHref: ImageHref
  fontFamily: FontFamilyOf
  nodeImage: (node: VectorNode) => NodeImage | null
  outlineApart: boolean
  xlink: boolean // whether an image needs the xlink namespace on the root
}

/** A node's fill, laid out in its fill box. */
const nodeFill = (node: VectorNode, defs: Defs) =>
  defs.gradients.fill(node.style.fill, () => fillBox(node))

/**
 * A rectangle, ellipse or path element, filled and outlined as Konva paints it: no fill is
 * fill="none", no outline no stroke at all. `filling` goes with the fill and `outlining` with the
 * outline. With outlineApart, a gradient-filled shape with an outline is two elements, the fill
 * under the outline.
 */
function shapeSvg(
  tag: string,
  node: ShapeNode,
  geometry: Attrs,
  { common, defs, indent }: { common: Attrs; defs: Defs; indent: string },
  filling: Attrs = {},
  outlining: Attrs = {},
): string {
  const { style } = node
  const fill = nodeFill(node, defs)
  const outline: Attrs =
    style.stroke === null ? {} : { stroke: style.stroke, 'stroke-width': style.strokeWidth }
  const element = (list: Attrs) => `${indent}<${tag}${attrs({ ...common, ...geometry, ...list })}/>`
  if (defs.outlineApart && style.stroke !== null && isGradient(style.fill)) {
    return `${element({ ...fill, ...filling })}
${element({ fill: 'none', ...outline, ...outlining })}`
  }
  return element({ ...fill, ...outline, ...filling, ...(style.stroke === null ? {} : outlining) })
}

const FONT_WEIGHTS: Record<TextNode['fontStyle'], string | undefined> = {
  normal: undefined,
  bold: 'bold',
  italic: undefined,
  'bold italic': 'bold',
}

const ANCHORS: Record<TextNode['align'], string | undefined> = {
  left: undefined,
  center: 'middle',
  right: 'end',
}

/**
 * A text as Konva lays it out: its wrapped lines one line height apart, each with its baseline
 * where Konva draws it, aligned within the node's width. text-anchor does the aligning, so a
 * viewer that swaps in a fallback font still centers or right-aligns the lines. The element is
 * written on one line: with xml:space="preserve", whitespace between the tspans would count as
 * trailing spaces and push centered and right-aligned lines to the left.
 */
function textSvg(
  node: TextNode,
  common: Attrs,
  defs: Defs,
  indent: string,
  invisible = false,
): string {
  const x = node.align === 'center' ? node.width / 2 : node.align === 'right' ? node.width : 0
  const baseline = firstBaseline(node)
  const step = node.fontSize * TEXT_LINE_HEIGHT
  const spans = textLines(node).flatMap((line, i) =>
    line === '' ? [] : [`<tspan${attrs({ x, y: baseline + i * step })}>${escapeXml(line)}</tspan>`],
  )
  if (spans.length === 0) return ''
  const open = `<text${attrs({
    ...common,
    ...(invisible ? { fill: 'none' } : nodeFill(node, defs)),
    'font-family': defs.fontFamily(node.fontFamily),
    'font-size': node.fontSize,
    'font-weight': FONT_WEIGHTS[node.fontStyle],
    'font-style': node.fontStyle.includes('italic') ? 'italic' : undefined,
    'text-anchor': ANCHORS[node.align],
    'xml:space': 'preserve',
  })}>`
  return `${indent}${open}${spans.join('')}</text>`
}

function lineSvg(node: NodeOf<'line'>, common: Attrs, markers: Markers): string {
  const [x1, y1, x2, y2] = node.points
  const { stroke, strokeWidth } = node.style
  const marker = (on: boolean, end: 'start' | 'end') =>
    on && stroke !== null ? `url(#${markers.id(stroke, strokeWidth, end)})` : undefined
  return `<line${attrs({
    ...common,
    x1,
    y1,
    x2,
    y2,
    stroke: stroke ?? undefined,
    'stroke-width': stroke === null ? undefined : strokeWidth,
    'stroke-linecap': 'round',
    'marker-start': marker(node.arrowStart, 'start'),
    'marker-end': marker(node.arrowEnd, 'end'),
  })}/>`
}

/**
 * An image as Konva draws it: stretched over its box. A cropped one is a nested <svg> whose
 * viewBox is the crop, which clips the rest; it sits in a <g> that carries the transform, since
 * SVG 1.1 has none on <svg>. Images use xlink:href, which every viewer reads.
 */
function imageSvg(doc: Doc, node: ImageNode, common: Attrs, defs: Defs, indent: string): string {
  const { width, height, crop } = node
  const asset = doc.assets[node.assetId]
  const href = asset ? defs.imageHref(asset) : null
  if (!asset || href === null) {
    return `${indent}<rect${attrs({ ...common, width, height, fill: IMAGE_PLACEHOLDER_COLOR })}/>`
  }
  defs.xlink = true
  if (crop === null) {
    return `${indent}<image${attrs({ ...common, width, height, preserveAspectRatio: 'none', 'xlink:href': href })}/>`
  }
  const viewBox = [crop.x, crop.y, crop.width, crop.height].map((n) => num(n)).join(' ')
  const image = `<image${attrs({ width: asset.width, height: asset.height, 'xlink:href': href })}/>`
  const clip = `<svg${attrs({ width, height, viewBox, preserveAspectRatio: 'none' })}>${image}</svg>`
  return `${indent}<g${attrs(common)}>${clip}</g>`
}

/**
 * The node and, for a group, its children, as SVG elements. Hidden nodes are left out. Konva fades
 * a see-through group child by child rather than as a whole, so a group's opacity is multiplied
 * into each child's instead of going on its <g>: the export looks like the screen.
 */
function nodeSvg(doc: Doc, node: VectorNode, fade: number, defs: Defs, indent: string): string {
  if (node.hidden) return ''
  const opacity = node.style.opacity * fade
  const common: Attrs = { transform: transformAttr(node.transform) }

  if (node.type === 'group') {
    const children = node.childIds
      .map((id) => doc.nodes[id])
      .filter((child) => child !== undefined)
      .map((child) => nodeSvg(doc, child, opacity, defs, `${indent}  `))
      .filter((svg) => svg !== '')
    if (children.length === 0) return ''
    return `${indent}<g${attrs(common)}>\n${children.join('\n')}\n${indent}</g>`
  }

  if (opacity < 1) common.opacity = opacity
  const image = defs.nodeImage(node)
  if (image) {
    defs.xlink = true
    const { href, ...box } = image
    const picture = `${indent}<image${attrs({ ...common, ...box, preserveAspectRatio: 'none', 'xlink:href': href })}/>`
    if (node.type !== 'text') return picture
    const text = textSvg(node, { transform: common.transform }, defs, indent, true)
    return text === ''
      ? picture
      : `${picture}
${text}`
  }
  switch (node.type) {
    case 'stroke':
      // The outline is a fill, as on the canvas.
      return `${indent}<path${attrs({ ...common, d: cachedStrokePath(node), ...nodeFill(node, defs) })}/>`
    case 'rect': {
      // Konva keeps a corner radius within half the shorter side; SVG would clamp rx and ry apart.
      const r = Math.max(0, Math.min(node.cornerRadius, node.width / 2, node.height / 2))
      const corner = r > 0 ? r : undefined
      const geometry = { width: node.width, height: node.height, rx: corner, ry: corner }
      return shapeSvg('rect', node, geometry, { common, defs, indent })
    }
    case 'ellipse':
      return shapeSvg('ellipse', node, { rx: node.rx, ry: node.ry }, { common, defs, indent })
    case 'line':
      return indent + lineSvg(node, common, defs.markers)
    case 'path': {
      // Konva draws paths with miter joins, round caps and canvas's miter limit of 10 (SVG's is 4).
      // Nonzero is SVG's default, as it is canvas's.
      return shapeSvg(
        'path',
        node,
        { d: cachedPathData(node) },
        { common, defs, indent },
        { 'fill-rule': node.fillRule === 'evenodd' ? 'evenodd' : undefined },
        { 'stroke-linejoin': 'miter', 'stroke-linecap': 'round', 'stroke-miterlimit': 10 },
      )
    }
    case 'text':
      return textSvg(node, common, defs, indent)
    case 'image':
      return imageSvg(doc, node, common, defs, indent)
  }
}

/**
 * A page of the doc (the first by default) as a standalone SVG at the page's size, built from the
 * model rather than from Konva: the background, then every visible node bottom to top, each
 * placed by its transform. Objects off the page are kept, and clipped by the viewBox. Images
 * hold their bytes as `imageHref` gives them, as data: URLs for a file.
 */
export function exportSvg(
  doc: Doc,
  pageId = doc.pages[0].id,
  {
    imageHref = () => null,
    fontFamily = ownFamily,
    idPrefix = '',
    nodeImage,
    outlineApart = false,
  }: SvgOptions = {},
): string {
  const page = pageById(doc, pageId) ?? doc.pages[0]
  const { width, height } = page
  const defs: Defs = {
    markers: new Markers(idPrefix),
    gradients: new Gradients(idPrefix),
    imageHref,
    fontFamily,
    nodeImage: nodeImage ?? (() => null),
    outlineApart,
    xlink: false,
  }
  const background = defs.gradients.fill(page.background, () => pageBox(page))
  const body = page.rootIds
    .map((id) => doc.nodes[id])
    .filter((node) => node !== undefined)
    .map((node) => nodeSvg(doc, node, 1, defs, '  '))
    .filter((svg) => svg !== '')
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<svg${attrs({
      xmlns: SVG_NS,
      'xmlns:xlink': defs.xlink ? XLINK_NS : undefined,
      viewBox: `0 0 ${width} ${height}`,
      width,
      height,
    })}>`,
  ]
  const written = [...defs.gradients.defs, ...defs.markers.defs]
  if (written.length > 0) {
    lines.push('  <defs>', ...written.map((def) => `    ${def}`), '  </defs>')
  }
  lines.push(`  <rect${attrs({ width, height, ...background })}/>`)
  lines.push(...body, '</svg>', '')
  return lines.join('\n')
}
