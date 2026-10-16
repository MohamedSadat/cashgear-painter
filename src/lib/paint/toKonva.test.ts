import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SHAPE_STYLE,
  DEFAULT_TEXT_STYLE,
  createEllipseNode,
  createLineNode,
  createPathNode,
  createRectNode,
  createStrokeNode,
  createTextNode,
} from '../../store/editorStore'
import { fillBox } from '../geometry/bounds'
import { corner } from '../geometry/pathData'
import { textHeight } from '../geometry/textLayout'
import { strokeOutlineBox } from '../strokePath'
import { newPage, type Paint, type Stop, type VectorNode } from '../../types'
import { solid } from './paint'
import { nodeKonvaFill, pageKonvaFill, toKonvaFill } from './toKonva'

const stops: Stop[] = [
  { offset: 1, color: '#3b82f6', opacity: 0.5 },
  { offset: 0, color: '#ef4444', opacity: 1 },
]
const linear: Paint = { kind: 'linear', stops, start: [0, 0.5], end: [1, 0.5] }
const radial: Paint = { kind: 'radial', stops, center: [0.5, 0.5], radius: 0.5 }
// Konva's flat list, in offset order, with opacity in the color.
const KONVA_STOPS = [0, '#ef4444', 1, 'rgba(59, 130, 246, 0.5)']

const withFill = <T extends VectorNode>(node: T, fill: Paint | null): T => ({
  ...node,
  style: { ...node.style, fill },
})

const rect = createRectNode({ x: 100, y: 50, width: 200, height: 80 }, DEFAULT_SHAPE_STYLE, 'r')
const box = () => ({ minX: 0, minY: 0, maxX: 200, maxY: 80 })

describe('toKonvaFill', () => {
  it('gives a solid or no fill as Konva’s color, with no gradient left over', () => {
    const red = toKonvaFill(solid('#ef4444'), box)
    expect(red).toMatchObject({ fill: '#ef4444', fillPriority: 'color' })
    expect(red.fillLinearGradientColorStops).toBeUndefined()
    expect(red.fillRadialGradientColorStops).toBeUndefined()
    // Every attribute is there, so react-konva clears an old gradient.
    expect(Object.keys(red)).toHaveLength(10)
    expect(toKonvaFill(null, box)).toMatchObject({ fill: undefined, fillPriority: 'color' })
  })

  it('lays a linear gradient out in local pixels from box units', () => {
    expect(toKonvaFill(linear, box)).toMatchObject({
      fill: undefined,
      fillPriority: 'linear-gradient',
      fillLinearGradientStartPoint: { x: 0, y: 40 },
      fillLinearGradientEndPoint: { x: 200, y: 40 },
      fillLinearGradientColorStops: KONVA_STOPS,
      fillRadialGradientColorStops: undefined,
    })
  })

  it('grows a radial gradient from its center to its radius in units of the longer side', () => {
    expect(toKonvaFill(radial, box)).toMatchObject({
      fill: undefined,
      fillPriority: 'radial-gradient',
      fillRadialGradientStartPoint: { x: 100, y: 40 },
      fillRadialGradientEndPoint: { x: 100, y: 40 },
      fillRadialGradientStartRadius: 0,
      fillRadialGradientEndRadius: 100,
      fillRadialGradientColorStops: KONVA_STOPS,
      fillLinearGradientColorStops: undefined,
    })
  })

  it('paints a gradient without extent as its last stop, as SVG does, and asks for no box for a solid', () => {
    expect(toKonvaFill({ ...linear, end: linear.start }, box)).toMatchObject({
      fill: 'rgba(59, 130, 246, 0.5)',
      fillPriority: 'color',
    })
    expect(toKonvaFill({ ...radial, radius: 0 }, box).fill).toBe('rgba(59, 130, 246, 0.5)')
    expect(toKonvaFill(linear, () => null).fill).toBe('rgba(59, 130, 246, 0.5)')
    toKonvaFill(solid('#000000'), () => {
      throw new Error('a solid needs no box')
    })
  })
})

describe('fill boxes', () => {
  it('lays gradients out in each node’s own coordinates, without its outline', () => {
    expect(fillBox(rect)).toEqual({ minX: 0, minY: 0, maxX: 200, maxY: 80 })
    const ellipse = createEllipseNode({ x: 0, y: 0, width: 100, height: 60 }, DEFAULT_SHAPE_STYLE)
    expect(fillBox(ellipse)).toEqual({ minX: -50, minY: -30, maxX: 50, maxY: 30 })
    // A path by its curves' extrema, not its handles: this arch rises to 75 % of its handles.
    const arch = createPathNode(
      [
        { ...corner(0, 0), outX: 0, outY: -100 },
        { ...corner(200, 0), inX: 0, inY: -100 },
      ],
      false,
      DEFAULT_SHAPE_STYLE,
    )
    const archBox = fillBox(arch)!
    expect(archBox.minY).toBeCloseTo(-75, 6)
    expect([archBox.minX, archBox.maxX, archBox.maxY]).toEqual([0, 200, 0])
    const stroke = createStrokeNode(
      [
        [10, 10, 0.5],
        [90, 40, 0.5],
      ],
      { color: '#000000', size: 12, usesPressure: false },
    )
    expect(fillBox(stroke)).toEqual(strokeOutlineBox(stroke))
    const text = createTextNode(0, 0, 300, DEFAULT_TEXT_STYLE, 'Two\nlines')
    expect(fillBox(text)).toEqual({ minX: 0, minY: 0, maxX: 300, maxY: textHeight(text) })
    expect(fillBox(createLineNode([0, 0], [10, 10], DEFAULT_SHAPE_STYLE))).toBeNull()
  })

  it('gives each node and page its gradient laid out in its box, cached by the object', () => {
    const ellipse = withFill(
      createEllipseNode({ x: 0, y: 0, width: 100, height: 60 }, DEFAULT_SHAPE_STYLE),
      radial,
    )
    const fill = nodeKonvaFill(ellipse)
    expect(fill).toMatchObject({
      fillRadialGradientStartPoint: { x: 0, y: 0 },
      fillRadialGradientEndRadius: 50,
    })
    expect(nodeKonvaFill(ellipse)).toBe(fill)
    const page = { ...newPage('p', 'Page', 800, 600), background: linear }
    expect(pageKonvaFill(page)).toMatchObject({
      fillLinearGradientStartPoint: { x: 0, y: 300 },
      fillLinearGradientEndPoint: { x: 800, y: 300 },
    })
    const text = withFill(createTextNode(0, 0, 300, DEFAULT_TEXT_STYLE, 'Hi'), linear)
    expect(nodeKonvaFill(text).fillLinearGradientEndPoint).toEqual({
      x: 300,
      y: textHeight(text) / 2,
    })
  })
})
