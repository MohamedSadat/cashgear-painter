import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from 'fflate'
import type { AssetId, Doc, ImageMime } from '../types'
import {
  assetExtension,
  isAssetId,
  mimeOfExtension,
  referencedAssets,
  withoutUnusedAssets,
} from './images/assetRefs'
import { sha256Hex } from './images/hash'
import { sniffMime } from './images/prepare'
import { NOT_A_DRAWING, docToJson, parseDocFile } from './persistence'

export const PAINTER_FILE_NAME = 'drawing.painter'
/** The drawing inside a .painter file; its images are beside it as assets/<sha256>.<ext>. */
export const DOC_ENTRY = 'doc.json'
const ASSET_ENTRY = /^assets\/([0-9a-f]{64})\.([a-z]+)$/

/** Whether the bytes start as a zip file does, as a .painter file does and a .painter.json doesn't. */
export const isZip = (bytes: Uint8Array) =>
  bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 3 && bytes[3] === 4

/**
 * A .painter file: a zip of doc.json, the doc as a .painter.json file holds it, and each image
 * the doc shows as assets/<sha256>.<ext>. Images are stored as they are, since they are
 * compressed already. Returns the ids of shown images whose bytes weren't in `bytesOf`.
 */
export function buildPainterFile(
  doc: Doc,
  bytesOf: ReadonlyMap<AssetId, Uint8Array>,
): { file: Uint8Array; missing: AssetId[] } {
  const saved = withoutUnusedAssets(doc)
  const files: Zippable = { [DOC_ENTRY]: [strToU8(docToJson(saved)), { level: 6 }] }
  const missing: AssetId[] = []
  for (const asset of Object.values(saved.assets)) {
    const bytes = bytesOf.get(asset.id)
    if (bytes) files[`assets/${asset.id}.${assetExtension(asset.mime)}`] = [bytes, { level: 0 }]
    else missing.push(asset.id)
  }
  return { file: zipSync(files), missing }
}

/** An image read from a .painter file. */
export interface OpenedAsset {
  id: AssetId
  mime: ImageMime
  bytes: Uint8Array
}

/**
 * The drawing and images in a .painter file. The doc is checked as an opened .painter.json is;
 * an image is taken only when the doc shows it and its bytes are the image type and SHA-256 its
 * name says. Throws an Error whose message tells the user what is wrong. `missing` counts the
 * images the doc shows without bytes for them, which show as gray boxes.
 */
export async function readPainterFile(
  bytes: Uint8Array,
): Promise<{ doc: Doc; assets: OpenedAsset[]; missing: number }> {
  let entries: Record<string, Uint8Array>
  try {
    entries = unzipSync(bytes)
  } catch {
    throw new Error(NOT_A_DRAWING)
  }
  const json = entries[DOC_ENTRY]
  if (!json) throw new Error(NOT_A_DRAWING)
  const doc = parseDocFile(strFromU8(json))
  const shown = referencedAssets(doc.nodes)
  const assets: OpenedAsset[] = []
  for (const [name, data] of Object.entries(entries)) {
    const match = ASSET_ENTRY.exec(name)
    if (!match) continue
    const [, id, extension] = match
    const mime = mimeOfExtension(extension)
    if (!isAssetId(id) || !shown.has(id) || assets.some((a) => a.id === id)) continue
    if (!mime || sniffMime(data) !== mime || doc.assets[id]?.mime !== mime) continue
    if ((await sha256Hex(data)) !== id) continue
    assets.push({ id, mime, bytes: data })
  }
  return { doc, assets, missing: shown.size - assets.length }
}
