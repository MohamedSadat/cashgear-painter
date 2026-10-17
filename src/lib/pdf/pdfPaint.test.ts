import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SHAPE_STYLE,
  DEFAULT_TEXT_STYLE,
  createLineNode,
  createRectNode,
  createTextNode,
} from '../../store/editorStore'
import type { Paint, VectorNode } from '../../types'
import { needsPicture, overWhite } from './pdfPaint'

const linear = (opacity = 1): Paint => ({
  kind: 'linear',
  stops: [
    { offset: 0, color: '#ff0000', opacity: 1 },
    { offset: 1, color: '#0000ff', opacity },
  ],
  start: [0, 0.5],
  end: [1, 0.5],
})

const withFill = <T extends VectorNode>(node: T, fill: Paint | null): T => ({
  ...node,
  style: { ...node.style, fill },
})

describe('needsPicture', () => {
  const rect = createRectNode({ x: 0, y: 0, width: 10, height: 10 }, DEFAULT_SHAPE_STYLE)
  const text = createTextNode(0, 0, 100, DEFAULT_TEXT_STYLE, 'Hi')

  it('pictures text filled with a gradient, and gradients with see-through stops', () => {
    expect(needsPicture(withFill(text, linear()))).toBe(true)
    expect(needsPicture(withFill(rect, linear(0.5)))).toBe(true)
  })

  it('leaves solid fills, no fill and opaque gradients on shapes to svg2pdf.js', () => {
    expect(needsPicture(text)).toBe(false)
    expect(needsPicture(withFill(rect, null))).toBe(false)
    expect(needsPicture(withFill(rect, { kind: 'solid', color: '#123456' }))).toBe(false)
    expect(needsPicture(withFill(rect, linear()))).toBe(false)
    expect(needsPicture(createLineNode([0, 0], [5, 5], DEFAULT_SHAPE_STYLE))).toBe(false)
  })
})

describe('overWhite', () => {
  it('lays see-through stops over white paper', () => {
    expect(overWhite(linear(0.5))).toEqual({
      ...linear(),
      stops: [
        { offset: 0, color: '#ff0000', opacity: 1 },
        { offset: 1, color: '#8080ff', opacity: 1 },
      ],
    })
    const short: Paint = {
      kind: 'radial',
      stops: [{ offset: 0, color: '#000', opacity: 0 }],
      center: [0.5, 0.5],
      radius: 0.5,
    }
    expect(overWhite(short)).toMatchObject({ stops: [{ color: '#ffffff', opacity: 1 }] })
  })

  it('keeps an opaque paint as it is', () => {
    const solid: Paint = { kind: 'solid', color: '#abcdef' }
    expect(overWhite(solid)).toBe(solid)
    const opaque = linear()
    expect(overWhite(opaque)).toBe(opaque)
  })
})
