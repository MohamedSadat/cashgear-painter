import { strToU8, unzipSync, zipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { createImageNode, createRectNode } from '../store/editorStore'
import { emptyDoc, type AssetMeta, type Doc } from '../types'
import { sha256Hex } from './images/hash'
import { DOC_ENTRY, buildPainterFile, isZip, readPainterFile } from './painterFile'
import { NOT_A_DRAWING, docToJson } from './persistence'

// Just enough of a PNG and a JPEG for their signatures.
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 9, 8, 7, 6, 5])

async function assetOf(bytes: Uint8Array, mime: AssetMeta['mime']): Promise<AssetMeta> {
  return { id: await sha256Hex(bytes), mime, width: 40, height: 20, bytes: bytes.length }
}

/** A doc with a rectangle, a cropped PNG and a JPEG shown twice. */
async function drawing() {
  const png = await assetOf(PNG, 'image/png')
  const jpeg = await assetOf(JPEG, 'image/jpeg')
  const doc: Doc = emptyDoc()
  const rect = createRectNode(
    { x: 1, y: 2, width: 30, height: 40 },
    {
      fill: { kind: 'solid', color: '#ff0000' },
      stroke: null,
      strokeWidth: 0,
      opacity: 1,
    },
  )
  const cropped = {
    ...createImageNode(png, { x: 10, y: 10, width: 40, height: 20 }, 'Logo'),
    crop: { x: 5, y: 0, width: 30, height: 20 },
  }
  const photo = createImageNode(jpeg, { x: 100, y: 10, width: 80, height: 40 }, 'Photo')
  const again = createImageNode(jpeg, { x: 300, y: 10, width: 40, height: 20 }, 'Photo')
  for (const node of [rect, cropped, photo, again]) doc.nodes[node.id] = node
  doc.pages[0].rootIds = [rect.id, cropped.id, photo.id, again.id]
  doc.assets = { [png.id]: png, [jpeg.id]: jpeg }
  const bytes = new Map([
    [png.id, PNG],
    [jpeg.id, JPEG],
  ])
  return { doc, png, jpeg, bytes }
}

describe('.painter files', () => {
  it('round-trip the doc and each image once, by its hash', async () => {
    const { doc, png, jpeg, bytes } = await drawing()
    const { file, missing } = buildPainterFile(doc, bytes)
    expect(missing).toEqual([])
    expect(isZip(file)).toBe(true)
    expect(Object.keys(unzipSync(file)).sort()).toEqual(
      [DOC_ENTRY, `assets/${jpeg.id}.jpg`, `assets/${png.id}.png`].sort(),
    )

    const opened = await readPainterFile(file)
    expect(opened.doc).toEqual(doc)
    expect(opened.missing).toBe(0)
    const byId = new Map(opened.assets.map((a) => [a.id, a]))
    expect([...byId.keys()].sort()).toEqual([png.id, jpeg.id].sort())
    expect(byId.get(png.id)!.bytes).toEqual(PNG)
    expect(byId.get(jpeg.id)!.mime).toBe('image/jpeg')
  })

  it("leaves out records and bytes of images the doc doesn't show any more", async () => {
    const { doc, png, jpeg, bytes } = await drawing()
    // The PNG's node is deleted; its record stays in the doc for undo.
    const pngNode = Object.values(doc.nodes).find(
      (n) => n.type === 'image' && n.assetId === png.id,
    )!
    delete doc.nodes[pngNode.id]
    doc.pages[0].rootIds = doc.pages[0].rootIds.filter((id) => id !== pngNode.id)
    const { file } = buildPainterFile(doc, bytes)
    const entries = unzipSync(file)
    expect(Object.keys(entries).sort()).toEqual([DOC_ENTRY, `assets/${jpeg.id}.jpg`].sort())
    expect(Object.keys((await readPainterFile(file)).doc.assets)).toEqual([jpeg.id])
  })

  it('keeps an image whose bytes are missing, and counts it', async () => {
    const { doc, png, jpeg, bytes } = await drawing()
    bytes.delete(jpeg.id)
    const { file, missing } = buildPainterFile(doc, bytes)
    expect(missing).toEqual([jpeg.id])
    const opened = await readPainterFile(file)
    expect(opened.assets.map((a) => a.id)).toEqual([png.id])
    expect(opened.missing).toBe(1)
    // The images stay, to show as gray boxes.
    expect(Object.values(opened.doc.nodes).filter((n) => n.type === 'image')).toHaveLength(3)
  })

  it('refuses bytes that are not what their name says', async () => {
    const { doc, png, jpeg } = await drawing()
    const forged = zipSync({
      [DOC_ENTRY]: strToU8(docToJson(doc)),
      // The JPEG's name on other bytes, and the PNG's bytes under a JPEG extension.
      [`assets/${jpeg.id}.jpg`]: Uint8Array.from([0xff, 0xd8, 0xff, 0, 0, 0]),
      [`assets/${png.id}.jpg`]: PNG,
    })
    const opened = await readPainterFile(forged)
    expect(opened.assets).toEqual([])
    expect(opened.missing).toBe(2)
  })

  it("refuses files that aren't drawings", async () => {
    await expect(readPainterFile(strToU8('not a zip'))).rejects.toThrow(NOT_A_DRAWING)
    const noDoc = zipSync({ 'other.txt': strToU8('hello') })
    await expect(readPainterFile(noDoc)).rejects.toThrow(NOT_A_DRAWING)
    const badVersion = zipSync({ [DOC_ENTRY]: strToU8('{"version":9,"nodes":{},"pages":[]}') })
    await expect(readPainterFile(badVersion)).rejects.toThrow('unknown version (9)')
  })
})
