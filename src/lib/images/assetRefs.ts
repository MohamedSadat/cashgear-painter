import type { AssetId, AssetMeta, Doc, ImageMime, NodeId, VectorNode } from '../../types'

/** What an image shows while it loads, or when its bytes can't be found. */
export const IMAGE_PLACEHOLDER_COLOR = '#d4d4d4'

/** The IndexedDB key of an asset's bytes: `asset:<sha256>`. */
export const ASSET_KEY_PREFIX = 'asset:'
export const assetKey = (id: AssetId) => `${ASSET_KEY_PREFIX}${id}`

/** Whether a string is an asset id: a SHA-256 as 64 lowercase hex digits. */
export const isAssetId = (value: unknown): value is AssetId =>
  typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)

const EXTENSIONS: Record<ImageMime, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
}

/** The file extension an asset is saved with in a .painter file. */
export const assetExtension = (mime: ImageMime) => EXTENSIONS[mime]

/** The asset type for a file extension; null for one that isn't an image's. */
export function mimeOfExtension(extension: string): ImageMime | null {
  const lower = extension.toLowerCase()
  if (lower === 'jpeg') return 'image/jpeg'
  const found = Object.entries(EXTENSIONS).find(([, ext]) => ext === lower)
  return found ? (found[0] as ImageMime) : null
}

type Nodes = Readonly<Record<NodeId, VectorNode>>

const refsCache = new WeakMap<Nodes, ReadonlySet<AssetId>>()

/** The assets the image nodes among `nodes` show; cached by the node map. */
export function referencedAssets(nodes: Nodes): ReadonlySet<AssetId> {
  let refs = refsCache.get(nodes)
  if (!refs) {
    const found = new Set<AssetId>()
    for (const node of Object.values(nodes)) if (node.type === 'image') found.add(node.assetId)
    refs = found
    refsCache.set(nodes, refs)
  }
  return refs
}

/** The doc's asset records, without those no image node shows any more; the same doc if none. */
export function withoutUnusedAssets(doc: Doc): Doc {
  const used = referencedAssets(doc.nodes)
  const ids = Object.keys(doc.assets)
  if (ids.every((id) => used.has(id))) return doc
  const assets: Record<AssetId, AssetMeta> = {}
  for (const id of ids) if (used.has(id)) assets[id] = doc.assets[id]
  return { ...doc, assets }
}
