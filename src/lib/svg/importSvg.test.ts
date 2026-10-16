import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SHAPE_STYLE,
  DEFAULT_TEXT_STYLE,
  createEllipseNode,
  createGroupNode,
  createLineNode,
  createPathNode,
  createRectNode,
  createStrokeNode,
  createTextNode,
  shapeToPath,
} from '../../store/editorStore'
import {
  applyTransform,
  canvasSegments,
  fillBox,
  invertTransform,
  nodeBounds,
} from '../geometry/bounds'
import { corner, type Cubic, type Xy } from '../geometry/pathData'
import { absoluteTransform } from '../geometry/transform'
import { isGradient, placeGradient, solid } from '../paint/paint'
import { strokeToPath } from '../strokePath'
import {
  IDENTITY_TRANSFORM,
  emptyDoc,
  type Anchor,
  type Doc,
  type GroupNode,
  type Paint,
  type PathNode,
  type Stop,
  type Transform,
  type StrokeNode,
  type VectorNode,
} from '../../types'
import { exportSvg } from './exportSvg'
import {
  contourAnchors,
  contoursOf,
  importSvgElement,
  type ImportArea,
  type SvgElementLike,
} from './importSvg'

/** Just enough of an XML element for the importer, as the DOM gives it in the browser. */
class XmlElement implements SvgElementLike {
  readonly localName: string
  readonly namespaceURI: string | null
  readonly children: XmlElement[] = []
  private readonly attributes: Map<string, string>

  constructor(localName: string, namespaceURI: string | null, attributes: Map<string, string>) {
    this.localName = localName
    this.namespaceURI = namespaceURI
    this.attributes = attributes
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null
  }
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }
const decode = (text: string) => text.replace(/&(amp|lt|gt|quot|apos);/g, (_, e) => ENTITIES[e])

/**
 * A small XML parser for the tests, since Node has no DOMParser: elements, attributes and
 * namespaces; comments, declarations and text are passed over.
 */
function parseXml(text: string): XmlElement {
  const markup =
    /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[[\s\S]*?\]\]>|<!DOCTYPE[^>]*>|<\/[^>]+>|<([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/g
  const open: { element: XmlElement; namespaces: Map<string, string> }[] = []
  let root: XmlElement | null = null
  for (const [whole, name, attributeText, selfClosing] of text.matchAll(markup)) {
    if (whole.startsWith('</')) {
      open.pop()
      continue
    }
    if (!name) continue
    const attributes = new Map<string, string>()
    for (const [, key, double, single] of (attributeText ?? '').matchAll(
      /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g,
    )) {
      attributes.set(key, decode(double ?? single))
    }
    const namespaces = new Map(open.at(-1)?.namespaces)
    for (const [key, value] of attributes) {
      if (key === 'xmlns') namespaces.set('', value)
      else if (key.startsWith('xmlns:')) namespaces.set(key.slice(6), value)
    }
    const colon = name.indexOf(':')
    const prefix = colon < 0 ? '' : name.slice(0, colon)
    const element = new XmlElement(
      name.slice(colon + 1),
      namespaces.get(prefix) ?? null,
      attributes,
    )
    const parent = open.at(-1)
    if (parent) parent.element.children.push(element)
    else root = element
    if (!selfClosing) open.push({ element, namespaces })
  }
  if (!root) throw new Error('no root element')
  return root
}

const SVG_OPEN = '<svg xmlns="http://www.w3.org/2000/svg">'
const importText = (svg: string, name?: string, area?: ImportArea) =>
  importSvgElement(parseXml(svg), name, area)

/** The imported nodes by id, and the import's top-level children in order. */
function imported(svg: string) {
  const result = importText(svg)
  const nodes = new Map(result.nodes.map((node) => [node.id, node]))
  const group = result.groupId === null ? null : (nodes.get(result.groupId) as GroupNode)
  const children = group?.childIds.map((id) => nodes.get(id)!) ?? []
  return { ...result, nodes, group, children }
}

const asPath = (node: VectorNode | undefined): PathNode => {
  expect(node?.type).toBe('path')
  return node as PathNode
}

function cubicAt([p0, p1, p2, p3]: Cubic, t: number): Xy {
  const u = 1 - t
  const at = (i: 0 | 1) =>
    u * u * u * p0[i] + 3 * u * u * t * p1[i] + 3 * u * t * t * p2[i] + t * t * t * p3[i]
  return [at(0), at(1)]
}

/** Expects two lists of segments to trace the same curves, to within 0.005 units. */
function expectSameCurves(actual: Cubic[], expected: Cubic[]) {
  expect(actual).toHaveLength(expected.length)
  actual.forEach((segment, i) => {
    for (const t of [0, 1 / 3, 2 / 3, 1]) {
      const [x, y] = cubicAt(segment, t)
      const [ex, ey] = cubicAt(expected[i], t)
      expect(x).toBeCloseTo(ex, 2)
      expect(y).toBeCloseTo(ey, 2)
    }
  })
}

/** A doc holding the nodes; nodes with a parent go into that group's childIds by the caller. */
function docOf(...nodes: VectorNode[]): Doc {
  const doc = emptyDoc()
  for (const node of nodes) {
    doc.nodes[node.id] = node
    if (node.parentId === null) doc.pages[0].rootIds.push(node.id)
  }
  return doc
}

/** A closed heart: a corner at the top dip and the bottom tip, a smooth side and a symmetric one. */
const HEART: Anchor[] = [
  { ...corner(100, 40), inX: -30, inY: -40, outX: 30, outY: -40 },
  { x: 200, y: 60, inX: 0, inY: -40, outX: 0, outY: 60, kind: 'smooth' },
  { ...corner(100, 200), inX: 60, inY: -50, outX: -60, outY: -50 },
  { x: 0, y: 60, inX: 0, inY: 50, outX: 0, outY: -50, kind: 'symmetric' },
]

describe('importSvg round trip', () => {
  // Everything inside the artboard, so the import lands where the export put it.
  const rect = {
    ...createRectNode(
      { x: 100, y: 100, width: 300, height: 120 },
      { ...DEFAULT_SHAPE_STYLE, fill: solid('#ef4444') },
      'rect',
    ),
    cornerRadius: 12,
  }
  rect.transform = { ...rect.transform, rotation: 30 }
  const ellipse = createEllipseNode(
    { x: 500, y: 100, width: 200, height: 120 },
    { fill: solid('#22c55e'), stroke: null, strokeWidth: 4, opacity: 0.5 },
    'ellipse',
  )
  const line = {
    ...createLineNode(
      [450, 400],
      [700, 450],
      { ...DEFAULT_SHAPE_STYLE, stroke: '#3b82f6', strokeWidth: 6 },
      'line',
    ),
    arrowEnd: true,
  }
  const heart = createPathNode(
    HEART,
    true,
    { ...DEFAULT_SHAPE_STYLE, fill: solid('#fde047') },
    'heart',
  )
  heart.transform = { ...heart.transform, x: 600, y: 400, rotation: 15 }
  const stroke: StrokeNode = {
    ...createStrokeNode(
      [
        [100, 600, 0.5],
        [160, 650, 0.6],
        [240, 640, 0.4],
        [300, 700, 0.5],
      ],
      { color: '#a855f7', size: 16, usesPressure: true },
      'stroke',
    ),
    transform: { x: 50, y: 0, rotation: 10, scaleX: 1.5, scaleY: 1.2 },
  }
  const child = createRectNode(
    { x: 0, y: 0, width: 100, height: 50 },
    { ...DEFAULT_SHAPE_STYLE, opacity: 0.8 },
    'child',
  )
  const group: GroupNode = {
    ...createGroupNode(['child'], null, 'group'),
    transform: { x: 900, y: 500, rotation: 20, scaleX: 1, scaleY: 1 },
    style: { fill: null, stroke: null, strokeWidth: 0, opacity: 0.5 },
  }
  const text = createTextNode(1000, 100, 300, DEFAULT_TEXT_STYLE, 'Hello', 'text')
  const hidden = {
    ...createEllipseNode({ x: 0, y: 0, width: 50, height: 50 }, DEFAULT_SHAPE_STYLE, 'hidden'),
    hidden: true,
  }
  const doc = docOf(
    rect,
    ellipse,
    line,
    heart,
    stroke,
    group,
    { ...child, parentId: 'group' },
    text,
    hidden,
  )
  const result = imported(exportSvg(doc))

  it('brings every visible shape back as a path in one group, skipping the text and the arrowhead', () => {
    expect(result.group).toMatchObject({
      name: 'Imported SVG',
      parentId: null,
      transform: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 },
    })
    expect(result.nodes.size).toBe(1 + 7)
    expect(result.children.map((node) => node.type)).toEqual([
      'path',
      'path',
      'path',
      'path',
      'path',
      'group',
    ])
    expect(result.skipped).toBe(2)
    for (const node of result.nodes.values()) {
      if (node.id !== result.groupId) expect(result.nodes.has(node.parentId!)).toBe(true)
    }
  })

  it('keeps shapes where they were, with their corners and curves', () => {
    const [rectPath, ellipsePath, linePath] = result.children.slice(0, 3).map(asPath)
    expectSameCurves(canvasSegments(rectPath), canvasSegments(shapeToPath(rect)))
    expect(rectPath.contours[0].anchors).toHaveLength(8)
    expect(rectPath.contours[0].closed).toBe(true)
    expectSameCurves(canvasSegments(ellipsePath), canvasSegments(shapeToPath(ellipse)))
    expect(ellipsePath.contours[0].anchors.map((a) => a.kind)).toEqual(Array(4).fill('symmetric'))
    expect(linePath.contours[0].closed).toBe(false)
    expect(
      linePath.contours[0].anchors.map((a) => applyTransform(linePath.transform, a.x, a.y)),
    ).toEqual([
      [450, 400],
      [700, 450],
    ])
  })

  it('keeps paths anchor for anchor, kinds included', () => {
    const path = asPath(result.children[3])
    expectSameCurves(canvasSegments(path), canvasSegments(heart))
    expect(path.contours[0].anchors.map((a) => a.kind)).toEqual([
      'corner',
      'smooth',
      'corner',
      'symmetric',
    ])
    expect(path.contours[0].closed).toBe(true)
  })

  it('keeps a freehand stroke as its filled outline', () => {
    const path = asPath(result.children[4])
    const [outline] = contoursOf(strokeToPath(stroke), [
      'translate(50 0) rotate(10) scale(1.5 1.2)',
    ])
    expect(path.contours[0].closed).toBe(true)
    // The outline's own points, from its quadratic curves, are the path's anchors.
    const ends = [outline.start, ...outline.segments.map((segment) => segment[3])]
    const anchors = path.contours[0].anchors.map((a) => applyTransform(path.transform, a.x, a.y))
    expect(anchors.length).toBeGreaterThan(10)
    anchors.forEach(([x, y], i) => {
      expect(x).toBeCloseTo(ends[i][0], 2)
      expect(y).toBeCloseTo(ends[i][1], 2)
    })
    const box = nodeBounds(path)!
    const original = nodeBounds(stroke)!
    // nodeBounds pads a stroke by its widest possible reach; the outline sits inside that.
    expect(box.minX).toBeGreaterThanOrEqual(original.minX)
    expect(box.maxY).toBeLessThanOrEqual(original.maxY)
  })

  it('keeps fill, outline and opacity, with a group’s opacity passed to its children', () => {
    const [rectPath, ellipsePath, linePath, , strokePath, groupCopy] = result.children
    expect(rectPath.style).toEqual({
      fill: solid('#ef4444'),
      stroke: '#000000',
      strokeWidth: 4,
      opacity: 1,
    })
    expect(ellipsePath.style).toMatchObject({ fill: solid('#22c55e'), stroke: null, opacity: 0.5 })
    expect(linePath.style).toEqual({ fill: null, stroke: '#3b82f6', strokeWidth: 6, opacity: 1 })
    expect(strokePath.style).toMatchObject({ fill: solid('#a855f7'), stroke: null, opacity: 1 })
    expect(groupCopy.style.opacity).toBe(1)

    const copy = asPath(result.nodes.get((groupCopy as GroupNode).childIds[0]))
    expect(copy.parentId).toBe(groupCopy.id)
    expect(copy.style.opacity).toBeCloseTo(0.4)
    const childOnCanvas = { ...child, transform: absoluteTransform(doc.nodes, 'child') }
    expectSameCurves(canvasSegments(copy), canvasSegments(shapeToPath(childOnCanvas)))
  })

  it('exports the import again the same way', () => {
    const again = imported(exportSvg(docOf(...result.nodes.values())))
    const shapes = (r: typeof result) =>
      [...r.nodes.values()].filter((node): node is PathNode => node.type === 'path')
    const first = shapes(result)
    const second = shapes(again)
    expect(second).toHaveLength(first.length)
    second.forEach((path, i) => {
      expectSameCurves(canvasSegments(path), canvasSegments(first[i]))
      expect(path.style).toEqual(first[i].style)
    })
  })
})

const GRADIENT_STOPS: Stop[] = [
  { offset: 0, color: '#ef4444', opacity: 1 },
  { offset: 0.4, color: '#22c55e', opacity: 0.5 },
  { offset: 1, color: '#3b82f6', opacity: 1 },
]
const LINEAR: Paint = { kind: 'linear', stops: GRADIENT_STOPS, start: [0.1, 0.2], end: [0.9, 0.7] }
const RADIAL: Paint = { kind: 'radial', stops: GRADIENT_STOPS, center: [0.4, 0.6], radius: 0.7 }

/** A node's gradient laid out in pixels, and the transform from there to the canvas. */
function placed(node: VectorNode, t: Transform = node.transform) {
  const paint = node.style.fill
  if (!isGradient(paint)) throw new Error(`${node.id} has no gradient`)
  return { gradient: placeGradient(paint, fillBox(node)!)!, t }
}

/** Where a canvas point is along a linear gradient: 0 at its start, 1 at its end. */
function along(node: VectorNode, t: Transform, point: Xy): number {
  const { gradient } = placed(node, t)
  if (gradient.kind !== 'linear') throw new Error('not linear')
  const [x, y] = invertTransform(t, point[0], point[1])
  const [sx, sy] = gradient.start
  const [vx, vy] = [gradient.end[0] - sx, gradient.end[1] - sy]
  return ((x - sx) * vx + (y - sy) * vy) / (vx * vx + vy * vy)
}

/** A radial gradient's center on the canvas, and its radius there for an unstretched transform. */
function radialOnCanvas(node: VectorNode, t: Transform = node.transform) {
  const { gradient } = placed(node, t)
  if (gradient.kind !== 'radial') throw new Error('not radial')
  return {
    center: applyTransform(t, ...gradient.center),
    radius: gradient.radius * Math.sqrt(Math.abs(t.scaleX * t.scaleY)),
  }
}

describe('importSvg gradients', () => {
  // A turned rectangle and a stretched, turned freehand stroke with linear gradients; a circle
  // and a turned path with radial ones; and a page background.
  const filled = { ...DEFAULT_SHAPE_STYLE, stroke: null }
  const rect = createRectNode(
    { x: 100, y: 100, width: 300, height: 120 },
    { ...filled, fill: LINEAR },
    'rect',
  )
  rect.transform = { ...rect.transform, rotation: 30 }
  const stroke: StrokeNode = {
    ...createStrokeNode(
      [
        [100, 600, 0.5],
        [160, 650, 0.6],
        [240, 640, 0.4],
        [300, 700, 0.5],
      ],
      { color: '#000000', size: 16, usesPressure: true },
      'stroke',
    ),
    transform: { x: 50, y: 0, rotation: 10, scaleX: 1.5, scaleY: 1.2 },
  }
  stroke.style = { ...stroke.style, fill: LINEAR }
  const circle = createEllipseNode(
    { x: 500, y: 100, width: 200, height: 200 },
    { ...filled, fill: RADIAL },
    'circle',
  )
  const heart = createPathNode(HEART, true, { ...filled, fill: RADIAL }, 'heart')
  heart.transform = { ...heart.transform, x: 600, y: 400, rotation: 15 }
  const doc = docOf(rect, stroke, circle, heart)
  doc.pages[0].background = LINEAR
  const result = imported(exportSvg(doc))
  const [rectPath, strokePath, circlePath, heartPath] = result.children.map(asPath)

  it('brings gradient fills back with their stops, skipping nothing', () => {
    expect(result.skipped).toBe(0)
    expect(result.children).toHaveLength(4)
    for (const path of [rectPath, strokePath]) {
      expect(path.style.fill).toMatchObject({ kind: 'linear', stops: GRADIENT_STOPS })
    }
    for (const path of [circlePath, heartPath]) {
      expect(path.style.fill).toMatchObject({ kind: 'radial', stops: GRADIENT_STOPS })
    }
  })

  it('keeps a linear gradient’s colors where they were on the canvas, on turned and stretched shapes', () => {
    for (const [original, copy] of [
      [rect, rectPath],
      [stroke, strokePath],
    ] as const) {
      for (const point of [
        [150, 150],
        [400, 300],
        [200, 650],
        [-100, 900],
      ] as Xy[]) {
        expect(along(copy, copy.transform, point)).toBeCloseTo(
          along(original, original.transform, point),
          4,
        )
      }
    }
    // An unturned box keeps its box units: the rectangle's corners stay its box's corners.
    const flat = { ...rect, transform: { ...rect.transform, rotation: 0 } }
    const again = asPath(imported(exportSvg(docOf(flat))).children[0])
    const paint = again.style.fill as Extract<Paint, { kind: 'linear' }>
    expect(paint.start[0]).toBeCloseTo(0.1, 5)
    expect(paint.start[1]).toBeCloseTo(0.2, 5)
    expect(paint.end[0]).toBeCloseTo(0.9, 5)
    expect(paint.end[1]).toBeCloseTo(0.7, 5)
  })

  it('keeps a radial gradient’s center and radius on the canvas', () => {
    for (const [original, copy] of [
      [circle, circlePath],
      [heart, heartPath],
    ] as const) {
      const before = radialOnCanvas(original)
      const after = radialOnCanvas(copy)
      expect(after.center[0]).toBeCloseTo(before.center[0], 2)
      expect(after.center[1]).toBeCloseTo(before.center[1], 2)
      expect(after.radius).toBeCloseTo(before.radius, 2)
    }
    // The circle's box is the same, so its box units are too.
    expect(circlePath.style.fill).toMatchObject({ center: [0.4, 0.6], radius: 0.7 })
  })
})

/** Imports one shape, its <defs> before it, and returns its fill. */
function fillOf(defs: string, shape: string): Paint | null | undefined {
  const result = imported(`${SVG_OPEN}<defs>${defs}</defs>${shape}</svg>`)
  return result.children[0]?.style.fill
}

describe('importSvg gradient subset', () => {
  const STOPS = '<stop offset="0" stop-color="#ff0000"/><stop offset="100%" stop-color="#0000ff"/>'
  const RED_BLUE = [
    { offset: 0, color: '#ff0000', opacity: 1 },
    { offset: 1, color: '#0000ff', opacity: 1 },
  ]

  it('reads bounding-box units by default, from left to right across the top', () => {
    expect(
      fillOf(
        `<linearGradient id="g">${STOPS}</linearGradient>`,
        '<rect x="10" y="20" width="200" height="100" fill="url(#g)"/>',
      ),
    ).toEqual({ kind: 'linear', stops: RED_BLUE, start: [0, 0], end: [1, 0] })
    expect(
      fillOf(
        `<radialGradient id="g" cx="0.25" cy="75%" r="0.5">${STOPS}</radialGradient>`,
        '<rect width="100" height="100" fill="url(#g)"/>',
      ),
    ).toEqual({ kind: 'radial', stops: RED_BLUE, center: [0.25, 0.75], radius: 0.5 })
  })

  it('maps user-space gradients through the shape’s transform into its box', () => {
    expect(
      fillOf(
        `<linearGradient id="g" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="0" y2="50">${STOPS}</linearGradient>`,
        '<rect width="100" height="100" transform="translate(300 200) scale(2)" fill="url(#g)"/>',
      ),
    ).toEqual({ kind: 'linear', stops: RED_BLUE, start: [0, 0], end: [0, 0.5] })
  })

  it('follows href for stops and attributes, as Inkscape writes gradients', () => {
    const fill = fillOf(
      `<linearGradient id="stops">${STOPS}</linearGradient>` +
        '<linearGradient id="g" xlink:href="#stops" gradientUnits="userSpaceOnUse" x1="0" y1="50" x2="100" y2="50" gradientTransform="rotate(90 50 50)"/>',
      '<rect width="100" height="100" fill="url(#g)"/>',
    )
    // Turned a quarter, the gradient runs from top to bottom: any transform works for a linear one.
    expect(fill?.kind).toBe('linear')
    const { start, end } = fill as Extract<Paint, { kind: 'linear' }>
    expect([start, end].flat().map((n) => Math.round(n * 1e6) / 1e6)).toEqual([0.5, 0, 0.5, 1])
    expect((fill as Extract<Paint, { kind: 'linear' }>).stops).toEqual(RED_BLUE)
  })

  it('takes a stop color’s alpha and stop-opacity, styles included, into its opacity', () => {
    const fill = fillOf(
      '<linearGradient id="g">' +
        '<stop offset="0" style="stop-color: rgba(255, 0, 0, 0.5); stop-opacity: 0.5"/>' +
        '<stop offset="0.6" stop-color="lime"/>' +
        '<stop offset="0.3" stop-color="#00f" stop-opacity="20%"/>' +
        '</linearGradient>',
      '<rect width="10" height="10" fill="url(#g)"/>',
    )
    // Node has no canvas to read named colors; lime reads as black here. An offset below an
    // earlier one is raised to it, as SVG does.
    expect((fill as Extract<Paint, { kind: 'linear' }>).stops).toEqual([
      { offset: 0, color: '#ff0000', opacity: 0.25 },
      { offset: 0.6, color: '#000000', opacity: 1 },
      { offset: 0.6, color: '#0000ff', opacity: 0.2 },
    ])
  })

  it('falls back to a solid color where a gradient can’t be kept', () => {
    // A radial gradient turned or skewed by its own transform paints its first stop.
    expect(
      fillOf(
        `<radialGradient id="g" gradientTransform="skewX(20)">${STOPS}</radialGradient>`,
        '<rect width="10" height="10" fill="url(#g)"/>',
      ),
    ).toEqual(solid('#ff0000'))
    // But a scale is fine.
    expect(
      fillOf(
        `<radialGradient id="g" gradientTransform="scale(0.5)">${STOPS}</radialGradient>`,
        '<rect width="10" height="10" fill="url(#g)"/>',
      ),
    ).toMatchObject({ kind: 'radial', center: [0.25, 0.25], radius: 0.25 })
    // One stop is a solid fill; none is no fill, so a shape without an outline goes.
    expect(
      fillOf(
        '<linearGradient id="g"><stop stop-color="#123456"/></linearGradient>',
        '<rect width="10" height="10" fill="url(#g)"/>',
      ),
    ).toEqual(solid('#123456'))
    expect(
      fillOf(
        '<linearGradient id="g"/>',
        '<rect width="10" height="10" fill="url(#g)" stroke="#000000"/>',
      ),
    ).toBeNull()
    expect(
      imported(
        `${SVG_OPEN}<defs><linearGradient id="g"/></defs><rect width="10" height="10" fill="url(#g)"/></svg>`,
      ).children,
    ).toHaveLength(0)
    // An unknown gradient is its fallback color, or no fill.
    expect(fillOf('', '<rect width="10" height="10" fill="url(#nope) #00ff00"/>')).toEqual(
      solid('#00ff00'),
    )
  })

  it('passes a gradient down from a group, laid out on each shape’s own box', () => {
    const result = imported(
      `${SVG_OPEN}<defs><linearGradient id="g">${STOPS}</linearGradient></defs>` +
        '<g fill="url(#g)"><rect width="10" height="10"/><rect x="100" width="50" height="20"/></g></svg>',
    )
    const group = result.children[0] as GroupNode
    for (const id of group.childIds) {
      expect(result.nodes.get(id)!.style.fill).toEqual({
        kind: 'linear',
        stops: RED_BLUE,
        start: [0, 0],
        end: [1, 0],
      })
    }
  })
})

describe('importSvg', () => {
  it('reads basic shapes, polylines and polygons as paths', () => {
    // All on the artboard, so the import stays where it is.
    const { children } = imported(`${SVG_OPEN}
      <circle cx="50" cy="60" r="10"/>
      <ellipse cx="100" cy="100" rx="20" ry="10"/>
      <rect x="10" y="20" width="30" height="40" rx="5"/>
      <line x1="5" y1="5" x2="35" y2="45" stroke="#f00"/>
      <polyline points="5,5 15,15 25,5" fill="none" stroke="#000"/>
      <polygon points="100 30, 110 40 120+5e-1"/>
    </svg>`)
    const paths = children.map(asPath)
    expect(paths.map((p) => [p.contours[0].anchors.length, p.contours[0].closed])).toEqual([
      [4, true],
      [4, true],
      [8, true],
      [2, false],
      [3, false],
      [3, true],
    ])
    expect(paths[0].transform).toMatchObject({ x: 60, y: 60 })
    // An rx alone rounds both ways.
    expect(nodeBounds(paths[2])).toEqual({ minX: 10, minY: 20, maxX: 40, maxY: 60 })
    expect(paths[3].style).toEqual({ fill: null, stroke: '#ff0000', strokeWidth: 1, opacity: 1 })
    expect(paths[0].style).toEqual({
      fill: solid('#000000'),
      stroke: null,
      strokeWidth: 4,
      opacity: 1,
    })
    // Numbers may run together when the next one has a sign.
    expect(
      paths[5].contours[0].anchors.map((a) => applyTransform(paths[5].transform, a.x, a.y)),
    ).toEqual([
      [100, 30],
      [110, 40],
      [120, 0.5],
    ])
  })

  it('leaves out shapes that draw nothing and counts unsupported elements as skipped', () => {
    const result = imported(`${SVG_OPEN}
      <title>A title</title>
      <desc>Not counted</desc>
      <metadata/>
      <defs><linearGradient id="g"><stop offset="0"/></linearGradient><clipPath id="c"/></defs>
      <style>.a { fill: red }</style>
      <text x="0" y="10">Text<tspan>more</tspan></text>
      <image href="x.png" width="10" height="10"/>
      <use href="#g"/>
      <rect width="0" height="10"/>
      <circle r="5" fill="none"/>
      <rect width="10" height="10" display="none"/>
      <g visibility="hidden"><rect width="10" height="10"/></g>
      <path d="M 0 0"/>
      <sodipodi:namedview xmlns:sodipodi="http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd"/>
    </svg>`)
    expect(result.groupId).toBeNull()
    expect(result.nodes.size).toBe(0)
    // The clip path in <defs> (not the gradient, which fills read), the style, the text, the
    // image and the use.
    expect(result.skipped).toBe(5)
  })

  it('inherits paint from groups, with inline styles over attributes', () => {
    const { children, nodes } = imported(`${SVG_OPEN}
      <g fill="#00ff00" stroke="#0000ff" stroke-width="3" color="rgb(255, 0, 0)" opacity="0.5">
        <rect width="10" height="10"/>
        <rect width="10" height="10" fill="currentColor" style="stroke: none; opacity: 50%"/>
        <rect width="10" height="10" fill="url(#gradient) #123" stroke="url(#pattern)"/>
        <rect width="10" height="10" fill="#abcd" stroke="rgba(0,0,0,0)" style="fill: #FFF !important"/>
      </g>
    </svg>`)
    const [group] = children
    expect(group.type).toBe('group')
    expect(group.style.opacity).toBe(0.5)
    const styles = (group as GroupNode).childIds.map((id) => nodes.get(id)!.style)
    expect(styles).toEqual([
      { fill: solid('#00ff00'), stroke: '#0000ff', strokeWidth: 3, opacity: 1 },
      { fill: solid('#ff0000'), stroke: null, strokeWidth: 4, opacity: 0.5 },
      { fill: solid('#112233'), stroke: null, strokeWidth: 4, opacity: 1 },
      { fill: solid('#ffffff'), stroke: null, strokeWidth: 4, opacity: 1 },
    ])
  })

  it('bakes nested transforms and the viewBox into anchors, scaling outline widths with them', () => {
    const { children, nodes } =
      imported(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 50 50" width="100mm" height="100mm">
      <g transform="translate(20 10)">
        <rect x="0" y="0" width="10" height="5" transform="scale(2) rotate(90)" stroke="#000" stroke-width="2"/>
      </g>
    </svg>`)
    // The <g> is a group with no transform of its own.
    const [group] = children as [GroupNode]
    expect(group.transform).toEqual(IDENTITY_TRANSFORM)
    const path = asPath(nodes.get(group.childIds[0]))
    // 100 mm is 377.95 px for 50 units: a scale of 7.559, and 2 more from the rect's own.
    const s = (100 * 96) / 25.4 / 50
    expect(path.style.strokeWidth).toBeCloseTo(2 * 2 * s, 2)
    const corners = path.contours[0].anchors.map((a) => applyTransform(path.transform, a.x, a.y))
    // (10, 5) turns to (-5, 10), doubles to (-10, 20), moves to (10, 30) and scales by s.
    expect(corners[2][0]).toBeCloseTo(10 * s, 2)
    expect(corners[2][1]).toBeCloseTo(30 * s, 2)
  })

  it('centers the viewBox in a viewport of another shape, as preserveAspectRatio does by default', () => {
    const { children } =
      imported(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="10 10 20 10" width="400" height="400">
      <ellipse cx="20" cy="15" rx="10" ry="5"/>
    </svg>`)
    // 20 × 10 units scale by 20 to 400 × 200, centered vertically in 400.
    expect(nodeBounds(children[0])).toEqual({ minX: 0, minY: 100, maxX: 400, maxY: 300 })
  })

  it('makes one path of a shape with several subpaths, a contour each, with its fill rule', () => {
    const { children, nodes } = imported(`${SVG_OPEN}
      <path d="M 0 0 h 10 v 10 h -10 z m 2 2 h 6 v 6 h -6 z" opacity="0.5"/>
      <g style="fill-rule: evenodd"><path d="M 20 0 h 10 v 10 h -10 z m 2 2 h 6 v 6 h -6 z"/></g>
    </svg>`)
    const [square, group] = children
    const path = asPath(square)
    expect(path.style.opacity).toBe(0.5)
    expect(path.contours.map((c) => [c.anchors.length, c.closed])).toEqual([
      [4, true],
      [4, true],
    ])
    expect(path.transform).toMatchObject({ x: 0, y: 0 })
    expect(path.contours[1].anchors[0]).toMatchObject({ x: 2, y: 2 })
    // Nonzero is the default; the rule is inherited from groups.
    expect(path.fillRule).toBe('nonzero')
    const inner = asPath(nodes.get((group as GroupNode).childIds[0]))
    expect(inner.fillRule).toBe('evenodd')
  })

  it('raises quadratic curves and arcs to cubics', () => {
    const { children } = imported(`${SVG_OPEN}
      <path d="M 0 0 Q 50 100 100 0 T 200 0 A 50 50 0 0 1 300 0" fill="none" stroke="#000"/>
    </svg>`)
    const path = asPath(children[0])
    // It reaches above the artboard, so it moves down onto it; measure from its start.
    const [[start, c1, c2]] = canvasSegments(path)
    // The quadratic's control point at 2/3 of the way from each end.
    expect(c1[0] - start[0]).toBeCloseTo(100 / 3)
    expect(c1[1] - start[1]).toBeCloseTo(200 / 3)
    expect(c2[0] - start[0]).toBeCloseTo(200 / 3)
    // The smooth quadratic continues the curve: a symmetric anchor between them.
    expect(path.contours[0].anchors[1].kind).toBe('symmetric')
    // The half circle's top is 50 above its ends, plus half the outline.
    expect(nodeBounds(path)!.minY - start[1]).toBeCloseTo(-50.5, 1)
  })

  it('scales a drawing larger than the artboard down to fit, and centers one off the artboard', () => {
    const big = imported(
      `${SVG_OPEN}<rect x="0" y="0" width="3200" height="1000" stroke="#000" stroke-width="10"/></svg>`,
    )
    const box = nodeBounds(big.children[0])!
    expect(box.maxX - box.minX).toBeCloseTo(1600)
    expect((box.minY + box.maxY) / 2).toBeCloseTo(500)
    // The outline shrinks with the drawing.
    expect(asPath(big.children[0]).style.strokeWidth).toBeCloseTo((10 * 1600) / 3210, 2)

    const off = imported(`${SVG_OPEN}<circle cx="-100" cy="0" r="50"/></svg>`)
    expect(nodeBounds(off.children[0])).toEqual({ minX: 750, minY: 450, maxX: 850, maxY: 550 })
  })

  it('fits and centers the drawing on the page it is imported into', () => {
    const result = importText(
      `${SVG_OPEN}<rect x="0" y="0" width="1600" height="1000"/></svg>`,
      'big',
      { width: 794, height: 1123 },
    )
    const nodes = new Map(result.nodes.map((node) => [node.id, node]))
    const group = nodes.get(result.groupId!) as GroupNode
    const box = nodeBounds(nodes.get(group.childIds[0])!)!
    expect(box.maxX - box.minX).toBeCloseTo(794)
    expect((box.minY + box.maxY) / 2).toBeCloseTo(1123 / 2)
  })

  it('leaves out a background rect that comes first and covers the whole viewBox', () => {
    const { children, skipped } =
      imported(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50">
      <title>Background</title>
      <rect width="100%" height="100%" fill="#fff"/>
      <rect width="100" height="50" fill="#000"/>
    </svg>`)
    expect(skipped).toBe(0)
    expect(children).toHaveLength(1)
    expect(children[0].style.fill).toEqual(solid('#000000'))
  })

  it('names the group after the file', () => {
    const result = importText(`${SVG_OPEN}<rect width="10" height="10"/></svg>`, 'logo')
    expect(result.nodes[0]).toMatchObject({ type: 'group', name: 'logo' })
  })
})

describe('contourAnchors', () => {
  const contour = (d: string) => contoursOf(d)[0]

  it('closes on the first anchor when a closed subpath ends where it started', () => {
    const anchors = contourAnchors(contour('M 0 0 C 10 -10 20 -10 30 0 C 20 10 10 10 0 0 Z'))!
    expect(anchors).toHaveLength(2)
    expect(anchors[0]).toMatchObject({ inX: 10, inY: 10, outX: 10, outY: -10 })
  })

  it('drops segments of no length and keeps a lone loop as two anchors', () => {
    expect(contourAnchors(contour('M 5 5 L 5 5 L 10 5'))).toHaveLength(2)
    expect(contourAnchors(contour('M 5 5 L 5 5'))).toBeNull()
    expect(contourAnchors(contour('M 0 0 C 10 -10 20 10 0 0 Z'))).toHaveLength(2)
  })

  it('makes an anchor smooth where a curve leaves a straight side in its direction', () => {
    const anchors = contourAnchors(contour('M 0 0 L 10 0 C 15 0 20 5 20 10'))!
    expect(anchors.map((a) => a.kind)).toEqual(['corner', 'smooth', 'corner'])
  })
})
