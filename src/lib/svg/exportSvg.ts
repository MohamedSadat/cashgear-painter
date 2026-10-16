import { arrowHeadSize } from '../geometry/bounds'
import { pathData } from '../geometry/pathData'
import { TEXT_LINE_HEIGHT, firstBaseline, quoteFamilies, textLines } from '../geometry/textLayout'
import { strokeToPath } from '../strokePath'
import type { Doc, NodeOf, Style, TextNode, Transform, VectorNode } from '../../types'

export const SVG_FILE_NAME = 'drawing.svg'
export const SVG_NS = 'http://www.w3.org/2000/svg'

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

  /**
   * A marker drawn as Konva draws an arrowhead: a triangle `arrowHeadSize` long and wide with its
   * tip on the line's end, filled and outlined in the line's color with round joins. A start
   * marker points backwards, so plain orient="auto" serves both ends.
   */
  id(color: string, width: number, end: 'start' | 'end'): string {
    const key = `${color} ${width} ${end}`
    let id = this.ids.get(key)
    if (id !== undefined) return id
    id = `arrow-${end}-${this.ids.size + 1}`
    this.ids.set(key, id)
    const head = arrowHeadSize(width)
    const back = end === 'end' ? -head : head
    const d = `M 0 0 L ${num(back)} ${num(head / 2)} L ${num(back)} ${num(-head / 2)} Z`
    this.defs.push(
      `<marker${attrs({ id, markerUnits: 'userSpaceOnUse', orient: 'auto', style: 'overflow:visible' })}>` +
        `<path${attrs({ d, fill: color, stroke: color, 'stroke-width': width, 'stroke-linejoin': 'round' })}/>` +
        '</marker>',
    )
    return id
  }
}

/** Fill and outline as Konva paints them: no fill is fill="none", no outline no stroke at all. */
function paint(style: Style): Attrs {
  return {
    fill: style.fill ?? 'none',
    stroke: style.stroke ?? undefined,
    'stroke-width': style.stroke === null ? undefined : style.strokeWidth,
  }
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
function textSvg(node: TextNode, common: Attrs, indent: string): string {
  const x = node.align === 'center' ? node.width / 2 : node.align === 'right' ? node.width : 0
  const baseline = firstBaseline(node)
  const step = node.fontSize * TEXT_LINE_HEIGHT
  const spans = textLines(node).flatMap((line, i) =>
    line === '' ? [] : [`<tspan${attrs({ x, y: baseline + i * step })}>${escapeXml(line)}</tspan>`],
  )
  if (spans.length === 0) return ''
  const open = `<text${attrs({
    ...common,
    fill: node.style.fill ?? 'none',
    'font-family': quoteFamilies(node.fontFamily).replaceAll('"', "'"),
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
 * The node and, for a group, its children, as SVG elements. Hidden nodes are left out. Konva fades
 * a see-through group child by child rather than as a whole, so a group's opacity is multiplied
 * into each child's instead of going on its <g>: the export looks like the screen.
 */
function nodeSvg(
  doc: Doc,
  node: VectorNode,
  fade: number,
  markers: Markers,
  indent: string,
): string {
  if (node.hidden) return ''
  const opacity = node.style.opacity * fade
  const common: Attrs = { transform: transformAttr(node.transform) }

  if (node.type === 'group') {
    const children = node.childIds
      .map((id) => doc.nodes[id])
      .filter((child) => child !== undefined)
      .map((child) => nodeSvg(doc, child, opacity, markers, `${indent}  `))
      .filter((svg) => svg !== '')
    if (children.length === 0) return ''
    return `${indent}<g${attrs(common)}>\n${children.join('\n')}\n${indent}</g>`
  }

  if (opacity < 1) common.opacity = opacity
  switch (node.type) {
    case 'stroke':
      // The outline is a fill, as on the canvas.
      return `${indent}<path${attrs({ ...common, d: strokeToPath(node), fill: node.style.fill ?? 'none' })}/>`
    case 'rect': {
      // Konva keeps a corner radius within half the shorter side; SVG would clamp rx and ry apart.
      const r = Math.max(0, Math.min(node.cornerRadius, node.width / 2, node.height / 2))
      return `${indent}<rect${attrs({
        ...common,
        width: node.width,
        height: node.height,
        rx: r > 0 ? r : undefined,
        ry: r > 0 ? r : undefined,
        ...paint(node.style),
      })}/>`
    }
    case 'ellipse':
      return `${indent}<ellipse${attrs({ ...common, rx: node.rx, ry: node.ry, ...paint(node.style) })}/>`
    case 'line':
      return indent + lineSvg(node, common, markers)
    case 'path': {
      // Konva draws paths with miter joins, round caps and canvas's miter limit of 10 (SVG's is 4).
      const outlined = node.style.stroke !== null
      return `${indent}<path${attrs({
        ...common,
        d: pathData(node.anchors, node.closed),
        ...paint(node.style),
        'stroke-linejoin': outlined ? 'miter' : undefined,
        'stroke-linecap': outlined ? 'round' : undefined,
        'stroke-miterlimit': outlined ? 10 : undefined,
      })}/>`
    }
    case 'text':
      return textSvg(node, common, indent)
  }
}

/**
 * The doc as a standalone SVG of the 1600 × 1000 artboard, built from the model rather than from
 * Konva: the background, then every visible node bottom to top, each placed by its transform.
 * Objects outside the artboard are kept, and clipped by the viewBox.
 */
export function exportSvg(doc: Doc): string {
  const markers = new Markers()
  const body = doc.rootIds
    .map((id) => doc.nodes[id])
    .filter((node) => node !== undefined)
    .map((node) => nodeSvg(doc, node, 1, markers, '  '))
    .filter((svg) => svg !== '')
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<svg${attrs({
      xmlns: SVG_NS,
      viewBox: `0 0 ${doc.width} ${doc.height}`,
      width: doc.width,
      height: doc.height,
    })}>`,
  ]
  if (markers.defs.length > 0) {
    lines.push('  <defs>', ...markers.defs.map((def) => `    ${def}`), '  </defs>')
  }
  lines.push(`  <rect${attrs({ width: doc.width, height: doc.height, fill: doc.background })}/>`)
  lines.push(...body, '</svg>', '')
  return lines.join('\n')
}
