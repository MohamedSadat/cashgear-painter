import { createStore, del, get, keys, set } from 'idb-keyval'
import { defaultStorage, loadV1Strokes, migrateV1, migrateV2 } from '../store/migrate'
import {
  DEFAULT_PAGE_HEIGHT,
  DEFAULT_PAGE_WIDTH,
  emptyDoc,
  newPage,
  type AssetId,
  type AssetMeta,
  type Contour,
  type Doc,
  type NodeId,
  type Page,
  type Point,
  type VectorNode,
} from '../types'
import {
  ASSET_KEY_PREFIX,
  assetKey,
  isAssetId,
  referencedAssets,
  withoutUnusedAssets,
} from './images/assetRefs'
import { isValidCrop } from './images/crop'
import { clampPageSize } from './pages'
import { isPaint } from './paint/paint'

export const STORAGE_KEY = 'painter:v3'
// v2's autosave, migrated once and then kept as a backup.
export const V2_STORAGE_KEY = 'painter:v2'
export const SAVE_DELAY_MS = 500
const DB_NAME = 'painter'
const DB_STORE_NAME = 'kv'

/** The slice of IndexedDB that autosave needs; tests pass an in-memory one. */
export interface KeyValueStore {
  get(key: string): Promise<unknown>
  set(key: string, value: unknown): Promise<void>
  // For cleaning up unused assets; without them, nothing is cleaned up.
  del?(key: string): Promise<void>
  keys?(): Promise<IDBValidKey[]>
}

interface DocState {
  doc: Doc
}

interface DocStore {
  getState(): DocState
  subscribe(listener: (state: DocState, previous: DocState) => void): () => void
}

let idbStore: KeyValueStore | null | undefined

/** idb-keyval on database `painter`; null when IndexedDB is missing or blocked. */
export function defaultKeyValueStore(): KeyValueStore | null {
  if (idbStore !== undefined) return idbStore
  try {
    // Reading indexedDB itself throws in some locked-down contexts.
    if (typeof indexedDB === 'undefined') {
      idbStore = null
    } else {
      const store = createStore(DB_NAME, DB_STORE_NAME)
      idbStore = {
        get: (key) => get(key, store),
        set: (key, value) => set(key, value, store),
        del: (key) => del(key, store),
        keys: () => keys(store),
      }
    }
  } catch {
    idbStore = null
  }
  return idbStore
}

const round = (n: number, digits: number) => {
  const factor = 10 ** digits
  return Math.round(n * factor) / factor
}

// Rounding keeps a busy drawing small, in IndexedDB and in saved files.
function compactNode(node: VectorNode): VectorNode {
  if (node.type !== 'stroke') return node
  return {
    ...node,
    points: node.points.map(([x, y, pressure]): Point => [
      round(x, 1),
      round(y, 1),
      round(pressure, 2),
    ]),
  }
}

// Asset records no image shows any more stay in the doc while the editor runs, for undo; they
// aren't saved.
function compactDoc(doc: Doc): Doc {
  const nodes: Record<NodeId, VectorNode> = {}
  for (const [id, node] of Object.entries(doc.nodes)) nodes[id] = compactNode(node)
  return { ...withoutUnusedAssets(doc), nodes }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isPoint(value: unknown): value is Point {
  return Array.isArray(value) && value.length === 3 && value.every(isFiniteNumber)
}

function isTransform(value: unknown): boolean {
  return (
    isObject(value) &&
    isFiniteNumber(value.x) &&
    isFiniteNumber(value.y) &&
    isFiniteNumber(value.rotation) &&
    isFiniteNumber(value.scaleX) &&
    isFiniteNumber(value.scaleY)
  )
}

const isColor = (value: unknown) => value === null || typeof value === 'string'

function isStyle(value: unknown): boolean {
  return (
    isObject(value) &&
    (value.fill === null || isPaint(value.fill)) &&
    isColor(value.stroke) &&
    isFiniteNumber(value.strokeWidth) &&
    isFiniteNumber(value.opacity)
  )
}

const isLength = (value: unknown) => isFiniteNumber(value) && value >= 0

const ANCHOR_KINDS: ReadonlySet<unknown> = new Set(['corner', 'smooth', 'symmetric'])
const FILL_RULES: ReadonlySet<unknown> = new Set(['nonzero', 'evenodd'])
const FONT_STYLES: ReadonlySet<unknown> = new Set(['normal', 'bold', 'italic', 'bold italic'])
const ALIGNS: ReadonlySet<unknown> = new Set(['left', 'center', 'right'])

function isAnchor(value: unknown): boolean {
  return (
    isObject(value) &&
    ['x', 'y', 'inX', 'inY', 'outX', 'outY'].every((key) => isFiniteNumber(value[key])) &&
    ANCHOR_KINDS.has(value.kind)
  )
}

// A contour needs a segment, so at least 2 anchors; the editor drops one that falls below that.
function isContour(value: unknown): value is Contour {
  return (
    isObject(value) &&
    Array.isArray(value.anchors) &&
    value.anchors.length >= 2 &&
    value.anchors.every(isAnchor) &&
    typeof value.closed === 'boolean'
  )
}

// Unknown node types are dropped.
const TYPE_CHECKS: Record<string, (node: Record<string, unknown>) => boolean> = {
  stroke: (node) =>
    Array.isArray(node.points) &&
    node.points.length > 0 &&
    node.points.every(isPoint) &&
    isFiniteNumber(node.size) &&
    typeof node.usesPressure === 'boolean',
  rect: (node) => isLength(node.width) && isLength(node.height) && isLength(node.cornerRadius),
  ellipse: (node) => isLength(node.rx) && isLength(node.ry),
  line: (node) =>
    Array.isArray(node.points) &&
    node.points.length === 4 &&
    node.points.every(isFiniteNumber) &&
    typeof node.arrowStart === 'boolean' &&
    typeof node.arrowEnd === 'boolean',
  // Malformed contours are dropped one by one (see keep); a path keeps at least one.
  path: (node) =>
    Array.isArray(node.contours) && node.contours.some(isContour) && FILL_RULES.has(node.fillRule),
  // Empty text is deleted when its edit ends, so a saved one is a leftover.
  text: (node) =>
    typeof node.text === 'string' &&
    node.text.trim() !== '' &&
    typeof node.fontFamily === 'string' &&
    isFiniteNumber(node.fontSize) &&
    node.fontSize > 0 &&
    FONT_STYLES.has(node.fontStyle) &&
    ALIGNS.has(node.align) &&
    isLength(node.width),
  // Children are checked one by one as the tree is walked.
  group: (node) => Array.isArray(node.childIds),
  // The asset and the crop are checked against the doc's asset records as the tree is walked.
  image: (node) =>
    isAssetId(node.assetId) &&
    isFiniteNumber(node.width) &&
    node.width > 0 &&
    isFiniteNumber(node.height) &&
    node.height > 0 &&
    (node.crop === null || isObject(node.crop)),
}

function isNode(id: string, value: unknown): value is VectorNode {
  if (!isObject(value) || typeof value.type !== 'string') return false
  const typeCheck = Object.hasOwn(TYPE_CHECKS, value.type) ? TYPE_CHECKS[value.type] : undefined
  return (
    value.id === id &&
    typeof value.name === 'string' &&
    (value.parentId === null || typeof value.parentId === 'string') &&
    isTransform(value.transform) &&
    isStyle(value.style) &&
    typeof value.hidden === 'boolean' &&
    typeof value.locked === 'boolean' &&
    typeCheck !== undefined &&
    typeCheck(value)
  )
}

const MIMES: ReadonlySet<unknown> = new Set(['image/png', 'image/jpeg', 'image/webp'])

function isAssetMeta(id: string, value: unknown): value is AssetMeta {
  return (
    isAssetId(id) &&
    isObject(value) &&
    value.id === id &&
    MIMES.has(value.mime) &&
    isFiniteNumber(value.width) &&
    value.width > 0 &&
    isFiniteNumber(value.height) &&
    value.height > 0 &&
    isLength(value.bytes)
  )
}

/** A page id not taken yet: page-1, page-2 and so on. */
function freePageId(taken: ReadonlySet<string>): string {
  let n = 1
  while (taken.has(`page-${n}`)) n += 1
  return `page-${n}`
}

/**
 * A doc that is safe to render: unreadable data becomes an empty doc, and malformed nodes are
 * dropped. Each page's tree is walked from its roots: a node is kept only under the parent its
 * `parentId` names, once in the whole doc, and a group keeps the children that pass; a group left
 * empty goes too, as do nodes no list reaches. Page ids are made unique, sizes kept in range and
 * unreadable backgrounds made white; a doc without pages gets an empty one. An image is kept only
 * with a record of its asset and a crop inside the image, and records no image uses are dropped.
 */
export function sanitizeDoc(value: unknown): Doc {
  const doc = emptyDoc()
  if (!isObject(value) || value.version !== 3 || !isObject(value.nodes)) return doc
  if (!Array.isArray(value.pages)) return doc

  const assets: Record<AssetId, AssetMeta> = {}
  if (isObject(value.assets)) {
    for (const [id, meta] of Object.entries(value.assets)) {
      if (isAssetMeta(id, meta)) assets[id] = meta
    }
  }

  const nodes = value.nodes
  const seen = new Set<string>()
  // The ids among `ids` that pass, added to doc.nodes with their checked subtrees.
  const keep = (ids: unknown[], parentId: string | null): string[] =>
    ids.flatMap((id) => {
      if (typeof id !== 'string' || seen.has(id) || !Object.hasOwn(nodes, id)) return []
      const node = nodes[id]
      if (!isNode(id, node) || node.parentId !== parentId) return []
      if (node.type === 'image') {
        const asset = Object.hasOwn(assets, node.assetId) ? assets[node.assetId] : undefined
        if (!asset || (node.crop !== null && !isValidCrop(node.crop, asset))) return []
      }
      seen.add(id)
      if (node.type === 'path') {
        doc.nodes[id] = { ...node, contours: node.contours.filter(isContour) }
        return [id]
      }
      if (node.type !== 'group') {
        doc.nodes[id] = node
        return [id]
      }
      const childIds = keep(node.childIds, id)
      if (childIds.length === 0) return []
      doc.nodes[id] = { ...node, childIds }
      return [id]
    })

  const pages: Page[] = []
  const pageIds = new Set<string>()
  for (const raw of value.pages) {
    if (!isObject(raw)) continue
    const id =
      typeof raw.id === 'string' && raw.id !== '' && !pageIds.has(raw.id)
        ? raw.id
        : freePageId(pageIds)
    pageIds.add(id)
    const page = newPage(
      id,
      typeof raw.name === 'string' && raw.name.trim() !== ''
        ? raw.name
        : `Page ${pages.length + 1}`,
      isFiniteNumber(raw.width) ? clampPageSize(raw.width) : DEFAULT_PAGE_WIDTH,
      isFiniteNumber(raw.height) ? clampPageSize(raw.height) : DEFAULT_PAGE_HEIGHT,
    )
    if (isPaint(raw.background)) page.background = raw.background
    page.rootIds = Array.isArray(raw.rootIds) ? keep(raw.rootIds, null) : []
    pages.push(page)
  }
  if (pages.length > 0) doc.pages = pages

  const used = referencedAssets(doc.nodes)
  for (const [id, meta] of Object.entries(assets)) if (used.has(id)) doc.assets[id] = meta
  return doc
}

export const DOC_FILE_NAME = 'drawing.painter.json'
export const NOT_A_DRAWING = "This file isn't a Simple Painter drawing."

/** The text of a .painter.json file: the doc as JSON, rounded as autosave rounds it. */
export function docToJson(doc: Doc): string {
  return JSON.stringify(compactDoc(doc))
}

/**
 * The doc in a .painter.json file, sanitized as a loaded doc is; a v2 file is migrated to one
 * page. Throws an Error whose message tells the user what is wrong: the file isn't a drawing, or
 * comes from an unknown version.
 */
export function parseDocFile(text: string): Doc {
  let value: unknown
  try {
    // Some editors put a byte order mark (U+FEFF) in front, which JSON.parse refuses.
    value = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text)
  } catch {
    throw new Error(NOT_A_DRAWING)
  }
  if (!isObject(value) || !('version' in value)) throw new Error(NOT_A_DRAWING)
  if (value.version !== 2 && value.version !== 3) {
    const version = String(JSON.stringify(value.version)).slice(0, 20)
    throw new Error(`This drawing is from an unknown version (${version}).`)
  }
  const list = value.version === 2 ? value.rootIds : value.pages
  if (!isObject(value.nodes) || !Array.isArray(list)) throw new Error(NOT_A_DRAWING)
  return sanitizeDoc(value.version === 2 ? migrateV2(value) : value)
}

/** The saved doc; undefined when nothing is saved yet or storage can't be read. */
export async function loadDoc(
  kv: KeyValueStore | null = defaultKeyValueStore(),
): Promise<Doc | undefined> {
  if (!kv) return undefined
  try {
    const value = await kv.get(STORAGE_KEY)
    return value === undefined ? undefined : sanitizeDoc(value)
  } catch (error) {
    console.warn('Loading the saved drawing failed', error)
    return undefined
  }
}

/**
 * The doc to open on start: the v3 autosave when there is one; otherwise the v2 autosave, or else
 * the v1 drawing, migrated once and saved as v3. The older keys stay as backups. Unreadable data
 * opens as an empty doc without migrating anything, and storage that can't be read at all opens
 * an empty doc and saves nothing, so a passing error can't put an older drawing over a newer one.
 */
export async function loadStartupDoc(
  kv: KeyValueStore | null = defaultKeyValueStore(),
  storage: Storage | null = defaultStorage(),
): Promise<Doc> {
  if (kv) {
    let saved: unknown
    let v2: unknown
    try {
      saved = await kv.get(STORAGE_KEY)
      if (saved === undefined) v2 = await kv.get(V2_STORAGE_KEY)
    } catch (error) {
      console.warn('Loading the saved drawing failed', error)
      return emptyDoc()
    }
    if (saved !== undefined) return sanitizeDoc(saved)
    if (v2 !== undefined) {
      const doc = sanitizeDoc(migrateV2(v2))
      await saveDoc(doc, kv)
      return doc
    }
  }
  const strokes = loadV1Strokes(storage)
  const doc = migrateV1(strokes)
  if (strokes.length > 0) await saveDoc(doc, kv)
  return doc
}

/**
 * Stores an asset's bytes under `asset:<sha256>`. Returns false when the write failed, for
 * example because storage is full or blocked.
 */
export async function saveAsset(
  id: AssetId,
  blob: Blob,
  kv: KeyValueStore | null = defaultKeyValueStore(),
): Promise<boolean> {
  if (!kv) return false
  try {
    await kv.set(assetKey(id), blob)
    return true
  } catch (error) {
    console.warn('Saving an image failed', error)
    return false
  }
}

/** An asset's stored bytes; undefined when they aren't stored or can't be read. */
export async function loadAsset(
  id: AssetId,
  kv: KeyValueStore | null = defaultKeyValueStore(),
): Promise<Blob | undefined> {
  if (!kv) return undefined
  try {
    const value = await kv.get(assetKey(id))
    return value instanceof Blob ? value : undefined
  } catch (error) {
    console.warn('Loading an image failed', error)
    return undefined
  }
}

/**
 * Deletes the stored assets the doc doesn't show. Run on start, when no undo history can bring
 * them back yet. Returns how many went.
 */
export async function cleanUpAssets(
  doc: Doc,
  kv: KeyValueStore | null = defaultKeyValueStore(),
): Promise<number> {
  if (!kv?.keys || !kv.del) return 0
  try {
    const used = referencedAssets(doc.nodes)
    const doomed = (await kv.keys()).filter(
      (key): key is string =>
        typeof key === 'string' &&
        key.startsWith(ASSET_KEY_PREFIX) &&
        !used.has(key.slice(ASSET_KEY_PREFIX.length)),
    )
    for (const key of doomed) await kv.del(key)
    return doomed.length
  } catch (error) {
    console.warn('Cleaning up unused images failed', error)
    return 0
  }
}

/** Returns false when the write failed, for example because storage is full or blocked. */
export async function saveDoc(
  doc: Doc,
  kv: KeyValueStore | null = defaultKeyValueStore(),
): Promise<boolean> {
  if (!kv) return false
  try {
    await kv.set(STORAGE_KEY, compactDoc(doc))
    return true
  } catch (error) {
    console.warn('Autosave failed', error)
    return false
  }
}

/**
 * Saves the doc 500 ms after it stops changing, and right away when the page is about to unload
 * (a refresh or closed tab) or is hidden (a tab or app switch). Returns a function that stops
 * autosaving.
 *
 * Chromium drops IndexedDB writes begun in `pagehide`, or in a `visibilitychange` to hidden
 * during unload, so a refresh or close is saved from `beforeunload`. That listener is there only
 * while a save is pending, because Firefox keeps a page with one out of its back/forward cache.
 * `pagehide` and `visibilitychange` cover tab and app switches, and iOS Safari, which doesn't
 * reliably fire `beforeunload`.
 */
export function startAutosave(
  store: DocStore,
  kv: KeyValueStore | null = defaultKeyValueStore(),
): () => void {
  const hasWindow = typeof window !== 'undefined'
  let timer: ReturnType<typeof setTimeout> | undefined

  const flush = () => {
    if (timer === undefined) return
    clearTimeout(timer)
    timer = undefined
    if (hasWindow) window.removeEventListener('beforeunload', flush)
    void saveDoc(store.getState().doc, kv)
  }

  const unsubscribe = store.subscribe((state, previous) => {
    if (state.doc === previous.doc) return
    clearTimeout(timer)
    timer = setTimeout(flush, SAVE_DELAY_MS)
    // Adding the same listener again does nothing.
    if (hasWindow) window.addEventListener('beforeunload', flush)
  })

  const onVisibilityChange = () => {
    if (document.visibilityState === 'hidden') flush()
  }
  if (hasWindow) {
    window.addEventListener('pagehide', flush)
    document.addEventListener('visibilitychange', onVisibilityChange)
  }

  return () => {
    clearTimeout(timer)
    unsubscribe()
    if (hasWindow) {
      window.removeEventListener('beforeunload', flush)
      window.removeEventListener('pagehide', flush)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }
}
