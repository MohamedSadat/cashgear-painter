import { createStore, get, set } from 'idb-keyval'
import { emptyDoc, type Doc, type NodeId, type Point, type VectorNode } from '../types'

export const STORAGE_KEY = 'painter:v2'
export const SAVE_DELAY_MS = 500
const DB_NAME = 'painter'
const DB_STORE_NAME = 'kv'

/** The slice of IndexedDB that autosave needs; tests pass an in-memory one. */
export interface KeyValueStore {
  get(key: string): Promise<unknown>
  set(key: string, value: unknown): Promise<void>
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
      idbStore = { get: (key) => get(key, store), set: (key, value) => set(key, value, store) }
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

function compactDoc(doc: Doc): Doc {
  const nodes: Record<NodeId, VectorNode> = {}
  for (const [id, node] of Object.entries(doc.nodes)) nodes[id] = compactNode(node)
  return { ...doc, nodes }
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
    isColor(value.fill) &&
    isColor(value.stroke) &&
    isFiniteNumber(value.strokeWidth) &&
    isFiniteNumber(value.opacity)
  )
}

// Other node types get their checks in their own milestones; until then they are dropped.
const TYPE_CHECKS: Record<string, (node: Record<string, unknown>) => boolean> = {
  stroke: (node) =>
    Array.isArray(node.points) &&
    node.points.length > 0 &&
    node.points.every(isPoint) &&
    isFiniteNumber(node.size) &&
    typeof node.usesPressure === 'boolean',
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

/**
 * A doc that is safe to render: unreadable data becomes an empty doc, and malformed nodes are
 * dropped. Only top-level nodes are kept for now; groups arrive in M12.
 */
export function sanitizeDoc(value: unknown): Doc {
  const doc = emptyDoc()
  if (!isObject(value) || value.version !== 2 || !isObject(value.nodes)) return doc
  if (!Array.isArray(value.rootIds)) return doc
  if (typeof value.background === 'string') doc.background = value.background

  const nodes = value.nodes
  for (const id of new Set(value.rootIds)) {
    if (typeof id !== 'string' || !Object.hasOwn(nodes, id)) continue
    const node = nodes[id]
    if (!isNode(id, node) || node.parentId !== null) continue
    doc.nodes[id] = node
    doc.rootIds.push(id)
  }
  return doc
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
 * Saves the doc 500 ms after it stops changing, and right away when the page is hidden
 * (a refresh, tab switch or app switch). Returns a function that stops autosaving.
 */
export function startAutosave(
  store: DocStore,
  kv: KeyValueStore | null = defaultKeyValueStore(),
): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined

  const flush = () => {
    if (timer === undefined) return
    clearTimeout(timer)
    timer = undefined
    void saveDoc(store.getState().doc, kv)
  }

  const unsubscribe = store.subscribe((state, previous) => {
    if (state.doc === previous.doc) return
    clearTimeout(timer)
    timer = setTimeout(flush, SAVE_DELAY_MS)
  })

  const onVisibilityChange = () => {
    if (document.visibilityState === 'hidden') flush()
  }
  const hasWindow = typeof window !== 'undefined'
  if (hasWindow) {
    window.addEventListener('pagehide', flush)
    document.addEventListener('visibilitychange', onVisibilityChange)
  }

  return () => {
    clearTimeout(timer)
    unsubscribe()
    if (hasWindow) {
      window.removeEventListener('pagehide', flush)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }
}
