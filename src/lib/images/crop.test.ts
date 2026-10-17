import { describe, expect, it } from 'vitest'
import { IDENTITY_TRANSFORM, type ImageNode } from '../../types'
import { applyTransform } from '../geometry/bounds'
import {
  applyDraft,
  cropOf,
  imageFrame,
  isValidCrop,
  moveBoxEdges,
  moveFrame,
  resetCrop,
  startDraft,
} from './crop'

const asset = { width: 400, height: 200 }

function image(changes: Partial<ImageNode> = {}): ImageNode {
  return {
    id: 'img',
    type: 'image',
    name: 'Photo',
    parentId: null,
    transform: { ...IDENTITY_TRANSFORM, x: 100, y: 50 },
    style: { fill: null, stroke: null, strokeWidth: 0, opacity: 1 },
    hidden: false,
    locked: false,
    assetId: 'a'.repeat(64),
    width: 200, // half the image's pixels
    height: 100,
    crop: null,
    ...changes,
  }
}

describe('crop math', () => {
  it('finds the whole image around the shown part', () => {
    expect(cropOf(image(), asset)).toEqual({ x: 0, y: 0, width: 400, height: 200 })
    // The right half, shown 100 × 100: the left half reaches 100 units past the node's left side.
    const node = image({ width: 100, height: 100, crop: { x: 200, y: 0, width: 200, height: 200 } })
    expect(imageFrame(node, asset)).toEqual({ x: -100, y: 0, width: 200, height: 100 })
  })

  it('crops by moving the box edges, keeping the image where it is', () => {
    const node = image()
    let draft = startDraft(node, asset)
    expect(draft.box).toEqual({ x: 0, y: 0, width: 200, height: 100 })
    draft = moveBoxEdges(draft, ['left', 'top'], 50, 20)
    draft = moveBoxEdges(draft, ['right'], 150, 0)
    expect(draft.box).toEqual({ x: 50, y: 20, width: 100, height: 80 })
    const applied = applyDraft(node, asset, draft)
    // 2 image pixels per unit.
    expect(applied.crop).toEqual({ x: 100, y: 40, width: 200, height: 160 })
    expect(applied.width).toBe(100)
    expect(applied.height).toBe(80)
    expect(applied.transform).toEqual({ ...node.transform, x: 150, y: 70 })
  })

  it('keeps the box inside the image and at least a unit across', () => {
    const draft = startDraft(image(), asset)
    expect(moveBoxEdges(draft, ['left'], -40, 0).box.x).toBe(0)
    expect(moveBoxEdges(draft, ['bottom'], 0, 500).box.height).toBe(100)
    const narrow = moveBoxEdges(draft, ['right'], -30, 0).box
    expect(narrow.x).toBe(0)
    expect(narrow.width).toBe(1)
  })

  it('moves the image inside the box, never leaving the box uncovered', () => {
    const node = image({ width: 100, height: 100, crop: { x: 200, y: 0, width: 200, height: 200 } })
    let draft = startDraft(node, asset)
    draft = moveFrame(draft, -60, 0)
    expect(draft.frame.x).toBe(-60)
    expect(applyDraft(node, asset, draft).crop).toEqual({ x: 120, y: 0, width: 200, height: 200 })
    // Too far either way stops at the image's edge.
    expect(moveFrame(draft, 30, 0).frame.x).toBe(0)
    expect(moveFrame(draft, -500, 9).frame).toEqual({ x: -100, y: 0, width: 200, height: 100 })
    // The image doesn't move, so the node stays put.
    expect(applyDraft(node, asset, draft).transform).toEqual(node.transform)
  })

  it('places a turned image by its own axes', () => {
    const node = image({ transform: { ...IDENTITY_TRANSFORM, x: 100, y: 50, rotation: 90 } })
    const draft = moveBoxEdges(startDraft(node, asset), ['left', 'top'], 50, 20)
    const applied = applyDraft(node, asset, draft)
    // The local point (50, 20) of a node turned a quarter: 20 units left of x, 50 down.
    expect(applied.transform.x).toBeCloseTo(80)
    expect(applied.transform.y).toBeCloseTo(100)
    expect(applied.transform.rotation).toBe(90)
  })

  it('a crop of the whole image is none, and Reset crop shows it all where it was', () => {
    const node = image()
    expect(applyDraft(node, asset, startDraft(node, asset)).crop).toBeNull()
    expect(resetCrop(node, asset)).toBeNull()

    const cropped = {
      ...node,
      ...applyDraft(node, asset, moveBoxEdges(startDraft(node, asset), ['left', 'top'], 50, 20)),
    }
    const reset = resetCrop(cropped, asset)!
    expect(reset.crop).toBeNull()
    expect(reset.width).toBeCloseTo(200)
    expect(reset.height).toBeCloseTo(100)
    expect(reset.transform.x).toBeCloseTo(100)
    expect(reset.transform.y).toBeCloseTo(50)
    // A point of the image stays on the same canvas spot through the crop and its reset.
    const pixel = (n: ImageNode, px: number, py: number) => {
      const crop = cropOf(n, asset)
      const lx = ((px - crop.x) / crop.width) * n.width
      const ly = ((py - crop.y) / crop.height) * n.height
      return applyTransform(n.transform, lx, ly)
    }
    expect(pixel(cropped, 300, 150)[0]).toBeCloseTo(pixel(node, 300, 150)[0])
    expect(pixel(cropped, 300, 150)[1]).toBeCloseTo(pixel(node, 300, 150)[1])
  })

  it('tells crops inside the image from others', () => {
    expect(isValidCrop({ x: 0, y: 0, width: 400, height: 200 }, asset)).toBe(true)
    expect(isValidCrop({ x: 10, y: 10, width: 391, height: 10 }, asset)).toBe(false)
    expect(isValidCrop({ x: 0, y: 0, width: 0, height: 10 }, asset)).toBe(false)
    expect(isValidCrop({ x: -1, y: 0, width: 10, height: 10 }, asset)).toBe(false)
    expect(isValidCrop({ x: Number.NaN, y: 0, width: 10, height: 10 }, asset)).toBe(false)
  })
})
