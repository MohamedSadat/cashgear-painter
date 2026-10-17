import { describe, expect, it } from 'vitest'
import { createGroupNode, createImageNode } from '../../store/editorStore'
import { emptyDoc, type AssetMeta, type Doc, type ImageNode, type VectorNode } from '../../types'
import { canvasBounds, fillBox, inkBounds, nodeBounds } from '../geometry/bounds'
import { nodeHitsSegment } from '../geometry/hitTest'
import { bakeTransform, bakeTransforms } from '../geometry/transform'
import { exportSvg } from '../svg/exportSvg'
import { IMAGE_PLACEHOLDER_COLOR } from './assetRefs'

const asset: AssetMeta = {
  id: 'a'.repeat(64),
  mime: 'image/png',
  width: 400,
  height: 200,
  bytes: 1000,
}
const DATA = 'data:image/png;base64,AAAA'

/** A 200 × 100 image at (100, 50), showing the whole 400 × 200 asset. */
const image = (changes: Partial<ImageNode> = {}): ImageNode => ({
  ...createImageNode(asset, { x: 100, y: 50, width: 200, height: 100 }, 'Photo', 'img'),
  ...changes,
})

function docOf(...nodes: VectorNode[]): Doc {
  const doc = emptyDoc()
  for (const node of nodes) {
    doc.nodes[node.id] = node
    if (node.parentId === null) doc.pages[0].rootIds.push(node.id)
  }
  doc.assets[asset.id] = asset
  return doc
}

describe('image geometry', () => {
  it('boxes an image by the part it shows, turned with it, and gives it no fill box', () => {
    expect(nodeBounds(image())).toEqual({ minX: 100, minY: 50, maxX: 300, maxY: 150 })
    const turned = image({ transform: { x: 100, y: 50, rotation: 90, scaleX: 1, scaleY: 1 } })
    const box = nodeBounds(turned)!
    expect(box.minX).toBeCloseTo(0)
    expect(box.maxX).toBeCloseTo(100)
    expect(box.maxY).toBeCloseTo(250)
    expect(fillBox(image())).toBeNull()
  })

  it('boxes an image in a group by where the group puts it', () => {
    const group = {
      ...createGroupNode(['img'], null, 'g'),
      transform: { x: 10, y: 20, rotation: 0, scaleX: 1, scaleY: 1 },
    }
    const doc = docOf(group, image({ parentId: 'g' }))
    expect(canvasBounds(doc.nodes, 'img')).toEqual({ minX: 110, minY: 70, maxX: 310, maxY: 170 })
    expect(inkBounds(doc.nodes, 'g')).toEqual({ minX: 110, minY: 70, maxX: 310, maxY: 170 })
  })

  it('is touched anywhere in its box, as Konva picks it', () => {
    expect(nodeHitsSegment(image(), [200, 100], [200, 100], 1)).toBe(true)
    expect(nodeHitsSegment(image(), [305, 100], [305, 100], 4)).toBe(false)
    expect(nodeHitsSegment(image(), [305, 100], [305, 100], 6)).toBe(true)
  })

  it('bakes a resize into its size, keeping the crop', () => {
    const cropped = image({ crop: { x: 10, y: 20, width: 100, height: 50 } })
    const t = { x: 0, y: 0, rotation: 30, scaleX: 2, scaleY: -0.5 }
    expect(bakeTransform(cropped, t)).toEqual({
      transform: { ...t, scaleX: 1, scaleY: 1 },
      width: 400,
      height: 50,
    })
    // In a group that is resized, as a child.
    const group = createGroupNode(['img'], null, 'g')
    const doc = docOf(group, image({ parentId: 'g', transform: { ...image().transform, x: 0 } }))
    const patch = bakeTransforms(doc.nodes, group, { ...group.transform, scaleX: 3, scaleY: 3 })
    expect(patch.img).toMatchObject({ width: 600, height: 300 })
  })
})

describe('exportSvg images', () => {
  const href = () => DATA

  it('writes an image stretched over its box, with its bytes inside', () => {
    const turned = image({
      transform: { x: 100, y: 50, rotation: 15, scaleX: 1, scaleY: 1 },
      style: { ...image().style, opacity: 0.5 },
    })
    const svg = exportSvg(docOf(turned), undefined, { imageHref: href })
    expect(svg).toContain('xmlns:xlink="http://www.w3.org/1999/xlink"')
    expect(svg).toContain(
      `<image transform="translate(100 50) rotate(15)" opacity="0.5" width="200" height="100" preserveAspectRatio="none" xlink:href="${DATA}"/>`,
    )
  })

  it('wraps a cropped image in an <svg> whose viewBox is the crop, in a placed <g>', () => {
    const cropped = image({ crop: { x: 50.25, y: 20, width: 300, height: 150 } })
    const svg = exportSvg(docOf(cropped), undefined, { imageHref: href })
    expect(svg).toContain(
      `<g transform="translate(100 50)"><svg width="200" height="100" viewBox="50.25 20 300 150" preserveAspectRatio="none"><image width="400" height="200" xlink:href="${DATA}"/></svg></g>`,
    )
  })

  it('writes a gray box where there are no bytes, and no xlink namespace without images', () => {
    const svg = exportSvg(docOf(image()))
    expect(svg).toContain(
      `<rect transform="translate(100 50)" width="200" height="100" fill="${IMAGE_PLACEHOLDER_COLOR}"/>`,
    )
    expect(svg).not.toContain('xmlns:xlink')
  })
})
