import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SHAPE_STYLE,
  DEFAULT_TEXT_STYLE,
  createEllipseNode,
  createGroupNode,
  createLineNode,
  createPathFromContours,
  createPathNode,
  createRectNode,
  createStrokeNode,
  createTextNode,
} from '../../store/editorStore'
import { arrowHeadSize } from '../geometry/bounds'
import { corner } from '../geometry/pathData'
import { firstBaseline, textHeight } from '../geometry/textLayout'
import { solid } from '../paint/paint'
import { strokeToPath } from '../strokePath'
import { emptyDoc, newPage, type Doc, type Paint, type VectorNode } from '../../types'
import { exportSvg, transformAttr } from './exportSvg'

/** A doc holding the nodes; nodes with a parent go into that group's childIds by the caller. */
function docOf(...nodes: VectorNode[]): Doc {
  const doc = emptyDoc()
  for (const node of nodes) {
    doc.nodes[node.id] = node
    if (node.parentId === null) doc.pages[0].rootIds.push(node.id)
  }
  return doc
}

/** The lines of the export that hold an element with this tag. */
const elements = (svg: string, tag: string) =>
  svg.split('\n').filter((line) => line.trimStart().startsWith(`<${tag}`))

const box = { x: 100, y: 50, width: 200, height: 80 }

describe('exportSvg', () => {
  it('writes the page and its background, and nothing else for an empty doc', () => {
    const svg = exportSvg(emptyDoc())
    expect(svg).toContain(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 1000" width="1600" height="1000">',
    )
    expect(elements(svg, 'rect')).toEqual(['  <rect width="1600" height="1000" fill="#ffffff"/>'])
    expect(svg).not.toContain('<defs>')
    expect(svg.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n')).toBe(true)
  })

  it('places nodes in Konva order and leaves out parts of a transform that change nothing', () => {
    expect(transformAttr({ x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 })).toBeNull()
    expect(transformAttr({ x: 10.12345, y: -3, rotation: 0, scaleX: 1, scaleY: 1 })).toBe(
      'translate(10.123 -3)',
    )
    expect(transformAttr({ x: 1, y: 2, rotation: -45.5, scaleX: 1.2345678, scaleY: -1 })).toBe(
      'translate(1 2) rotate(-45.5) scale(1.234568 -1)',
    )
  })

  it('writes each shape with its geometry, paint and opacity', () => {
    const rect = createRectNode(box, { ...DEFAULT_SHAPE_STYLE, fill: solid('#ef4444') }, 'r')
    const ellipse = createEllipseNode(box, { ...DEFAULT_SHAPE_STYLE, opacity: 0.5 }, 'e')
    const path = createPathNode(
      [corner(0, 0), { ...corner(100, 0), inX: -20, inY: 30 }],
      true,
      { ...DEFAULT_SHAPE_STYLE, stroke: '#22c55e', strokeWidth: 6 },
      'p',
    )
    const svg = exportSvg(docOf(rect, ellipse, path))
    expect(elements(svg, 'rect')[1].trim()).toBe(
      '<rect transform="translate(100 50)" width="200" height="80" fill="#ef4444" stroke="#000000" stroke-width="4"/>',
    )
    expect(elements(svg, 'ellipse')[0].trim()).toBe(
      '<ellipse transform="translate(200 90)" opacity="0.5" rx="100" ry="40" fill="none" stroke="#000000" stroke-width="4"/>',
    )
    // Konva's miter limit is 10; SVG's default is 4.
    expect(elements(svg, 'path')[0].trim()).toBe(
      '<path d="M 0 0 C 0 0 80 30 100 0 C 100 0 0 0 0 0 Z" fill="none" stroke="#22c55e" stroke-width="6" stroke-linejoin="miter" stroke-linecap="round" stroke-miterlimit="10"/>',
    )
  })

  it('writes gradient fills into <defs>, in the pixels of each element’s own coordinates', () => {
    const stops = [
      { offset: 1, color: '#3b82f6', opacity: 0.5 },
      { offset: 0, color: '#ef4444', opacity: 1 },
    ]
    const linear: Paint = { kind: 'linear', stops, start: [0, 0.5], end: [1, 0.5] }
    const radial: Paint = { kind: 'radial', stops, center: [0.5, 0.5], radius: 0.5 }
    const filled = { ...DEFAULT_SHAPE_STYLE, stroke: null }
    const rect = createRectNode(box, { ...filled, fill: linear }, 'r')
    const twin = createRectNode({ ...box, x: 400 }, { ...filled, fill: linear }, 'twin')
    const ellipse = createEllipseNode(box, { ...filled, fill: radial }, 'e')
    const flat = createRectNode(box, { ...filled, fill: { ...linear, end: [0, 0.5] } }, 'flat')
    const text = {
      ...createTextNode(0, 0, 300, DEFAULT_TEXT_STYLE, 'Hi', 't'),
      style: { ...filled, fill: radial },
    }
    const doc = docOf(rect, twin, ellipse, flat, text)
    doc.pages[0].background = radial
    const svg = exportSvg(doc)

    const stopsSvg =
      '<stop offset="0" stop-color="#ef4444"/><stop offset="1" stop-color="#3b82f6" stop-opacity="0.5"/>'
    const defs = svg.slice(svg.indexOf('<defs>'), svg.indexOf('</defs>'))
    // userSpaceOnUse, as Konva lays them out: objectBoundingBox would stretch a radial one.
    expect(
      defs
        .split('\n')
        .slice(1, -1)
        .map((line) => line.trim()),
    ).toEqual([
      `<radialGradient id="gradient-1" gradientUnits="userSpaceOnUse" cx="800" cy="500" r="800">${stopsSvg}</radialGradient>`,
      `<linearGradient id="gradient-2" gradientUnits="userSpaceOnUse" x1="0" y1="40" x2="200" y2="40">${stopsSvg}</linearGradient>`,
      `<radialGradient id="gradient-3" gradientUnits="userSpaceOnUse" cx="0" cy="0" r="100">${stopsSvg}</radialGradient>`,
      `<radialGradient id="gradient-4" gradientUnits="userSpaceOnUse" cx="150" cy="${Math.round(textHeight(text) * 500) / 1000}" r="150">${stopsSvg}</radialGradient>`,
    ])
    expect(elements(svg, 'rect').map((line) => line.trim())).toEqual([
      '<rect width="1600" height="1000" fill="url(#gradient-1)"/>',
      '<rect transform="translate(100 50)" width="200" height="80" fill="url(#gradient-2)"/>',
      // The same gradient on the same box is written once.
      '<rect transform="translate(400 50)" width="200" height="80" fill="url(#gradient-2)"/>',
      // Without extent, the last stop, as on the canvas.
      '<rect transform="translate(100 50)" width="200" height="80" fill="#3b82f6" fill-opacity="0.5"/>',
    ])
    expect(elements(svg, 'ellipse')[0]).toContain('fill="url(#gradient-3)"')
    expect(elements(svg, 'text')[0]).toContain('fill="url(#gradient-4)"')
  })

  it('writes the page asked for, at its own size and background', () => {
    const doc = docOf(createRectNode(box, DEFAULT_SHAPE_STYLE, 'r'))
    const a4 = { ...newPage('a4', 'A4', 794, 1123), background: solid('#fef3c7') }
    doc.pages.push({ ...a4, rootIds: [] })

    const svg = exportSvg(doc, 'a4')
    expect(svg).toContain('viewBox="0 0 794 1123" width="794" height="1123"')
    expect(elements(svg, 'rect')).toEqual(['  <rect width="794" height="1123" fill="#fef3c7"/>'])
    // The first page by default.
    expect(elements(exportSvg(doc), 'rect')).toHaveLength(2)
  })

  it('writes the fill rule of a path with holes', () => {
    const square = (from: number, to: number) => [
      corner(from, from),
      corner(to, from),
      corner(to, to),
      corner(from, to),
    ]
    const donut = createPathFromContours(
      [
        { anchors: square(0, 100), closed: true },
        { anchors: square(25, 75), closed: true },
      ],
      { ...DEFAULT_SHAPE_STYLE, fill: solid('#ef4444'), stroke: null },
      'evenodd',
      'd',
    )
    const [path] = elements(exportSvg(docOf(donut)), 'path')
    expect(path).toContain('fill-rule="evenodd"')
    expect(path.match(/M /g)).toHaveLength(2)
    expect(elements(exportSvg(docOf({ ...donut, fillRule: 'nonzero' })), 'path')[0]).not.toContain(
      'fill-rule',
    )
  })

  it('keeps a corner radius within half the shorter side on both axes, as Konva does', () => {
    const rect = { ...createRectNode(box, DEFAULT_SHAPE_STYLE, 'r'), cornerRadius: 999 }
    expect(elements(exportSvg(docOf(rect)), 'rect')[1]).toContain('rx="40" ry="40"')
  })

  it('writes a freehand stroke as its filled outline', () => {
    const stroke = {
      ...createStrokeNode(
        [
          [10, 10, 0.5],
          [60, 40, 0.5],
          [120, 20, 0.5],
        ],
        { color: '#3b82f6', size: 12, usesPressure: false },
        's',
      ),
      transform: { x: 5, y: 6, rotation: 30, scaleX: 2, scaleY: 1.5 },
    }
    const [line] = elements(exportSvg(docOf(stroke)), 'path')
    expect(line.trim()).toBe(
      `<path transform="translate(5 6) rotate(30) scale(2 1.5)" d="${strokeToPath(stroke)}" fill="#3b82f6"/>`,
    )
  })

  it('gives lines round caps and arrowhead markers the size Konva draws, one per color and end', () => {
    const style = { ...DEFAULT_SHAPE_STYLE, strokeWidth: 4 }
    const a = { ...createLineNode([0, 0], [100, 0], style, 'a'), arrowStart: true, arrowEnd: true }
    const b = { ...createLineNode([0, 50], [100, 50], style, 'b'), arrowEnd: true }
    const c = createLineNode([0, 90], [100, 90], { ...style, stroke: '#ff0000' }, 'c')
    const svg = exportSvg(docOf(a, b, c))
    const head = arrowHeadSize(4)
    expect(head).toBe(26)
    expect(elements(svg, 'marker')).toEqual([
      `    <marker id="arrow-start-1" markerUnits="userSpaceOnUse" orient="auto" style="overflow:visible"><path d="M 0 0 L 26 13 L 26 -13 Z" fill="#000000" stroke="#000000" stroke-width="4" stroke-linejoin="round"/></marker>`,
      `    <marker id="arrow-end-2" markerUnits="userSpaceOnUse" orient="auto" style="overflow:visible"><path d="M 0 0 L -26 13 L -26 -13 Z" fill="#000000" stroke="#000000" stroke-width="4" stroke-linejoin="round"/></marker>`,
    ])
    expect(elements(svg, 'line').map((l) => l.trim())).toEqual([
      '<line x1="0" y1="0" x2="100" y2="0" stroke="#000000" stroke-width="4" stroke-linecap="round" marker-start="url(#arrow-start-1)" marker-end="url(#arrow-end-2)"/>',
      '<line transform="translate(0 50)" x1="0" y1="0" x2="100" y2="0" stroke="#000000" stroke-width="4" stroke-linecap="round" marker-end="url(#arrow-end-2)"/>',
      '<line transform="translate(0 90)" x1="0" y1="0" x2="100" y2="0" stroke="#ff0000" stroke-width="4" stroke-linecap="round"/>',
    ])
  })

  it('writes text as one tspan per wrapped line, on the baselines Konva draws', () => {
    const text = createTextNode(
      10,
      20,
      // 0.6 em per glyph in Node: 6 glyphs at 50 units fit in 200.
      200,
      { ...DEFAULT_TEXT_STYLE, fontSize: 50, fontFamily: 'Trebuchet MS, Helvetica, sans-serif' },
      'abc de <&>\n\nlast',
      't',
    )
    const centered = {
      ...text,
      id: 'c',
      align: 'center' as const,
      fontStyle: 'bold italic' as const,
    }
    const svg = exportSvg(docOf(text, centered))
    const baseline = firstBaseline(text)
    // Konva's fallback metrics: the 'M' font box centered in the 1.2 line height.
    expect(baseline).toBeCloseTo(50 * ((0.91 - 0.21) / 2 + 0.6))
    // One line per text: whitespace between preserved tspans would move aligned lines.
    expect(elements(svg, 'text').map((l) => l.trim())).toEqual([
      `<text transform="translate(10 20)" fill="#000000" font-family="'Trebuchet MS', Helvetica, sans-serif" font-size="50" xml:space="preserve">` +
        '<tspan x="0" y="47.5">abc de</tspan>' +
        '<tspan x="0" y="107.5">&lt;&amp;&gt;</tspan>' +
        // The empty line keeps its place.
        '<tspan x="0" y="227.5">last</tspan></text>',
      `<text transform="translate(10 20)" fill="#000000" font-family="'Trebuchet MS', Helvetica, sans-serif" font-size="50" font-weight="bold" font-style="italic" text-anchor="middle" xml:space="preserve">` +
        '<tspan x="100" y="47.5">abc de</tspan>' +
        '<tspan x="100" y="107.5">&lt;&amp;&gt;</tspan>' +
        '<tspan x="100" y="227.5">last</tspan></text>',
    ])
  })

  it('nests groups, multiplies their opacity into their children and skips hidden nodes', () => {
    const inner = createRectNode(box, { ...DEFAULT_SHAPE_STYLE, opacity: 0.5 }, 'inner')
    const hidden = { ...createEllipseNode(box, DEFAULT_SHAPE_STYLE, 'hidden'), hidden: true }
    const group = {
      ...createGroupNode(['inner', 'hidden'], null, 'g'),
      transform: { x: 10, y: 0, rotation: 90, scaleX: 1, scaleY: 1 },
      style: { fill: null, stroke: null, strokeWidth: 0, opacity: 0.5 },
    }
    const empty = createGroupNode(['gone'], null, 'empty')
    const gone = { ...createRectNode(box, DEFAULT_SHAPE_STYLE, 'gone'), hidden: true }
    const doc = docOf(group, { ...inner, parentId: 'g' }, { ...hidden, parentId: 'g' }, empty, {
      ...gone,
      parentId: 'empty',
    })
    const svg = exportSvg(doc)
    expect(svg).toContain(
      '  <g transform="translate(10 0) rotate(90)">\n    <rect transform="translate(100 50)" opacity="0.25"',
    )
    expect(elements(svg, 'g')).toHaveLength(1)
    expect(svg).not.toContain('<ellipse')
  })
})
