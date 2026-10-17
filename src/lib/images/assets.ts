import { useEffect, useSyncExternalStore } from 'react'
import type { AssetId, Doc, VectorNode } from '../../types'
import { loadAsset } from '../persistence'
import { referencedAssets } from './assetRefs'

/** How an asset shows: still loading, drawable, or with no bytes to be found. */
export interface AssetState {
  status: 'idle' | 'loading' | 'ready' | 'missing'
  image: HTMLImageElement | null
  preview: string | null // a small data: URL of the image, for page thumbnails
}

const IDLE: AssetState = { status: 'idle', image: null, preview: null }
const LOADING: AssetState = { status: 'loading', image: null, preview: null }
const MISSING: AssetState = { status: 'missing', image: null, preview: null }

interface Entry {
  blob: Blob | null // the bytes, once known
  url: string | null // an object URL of them, while the image uses it
  state: AssetState
}

/** What the cache needs from the browser; tests pass stand-ins. */
export interface AssetCacheOptions {
  load(id: AssetId): Promise<Blob | undefined>
  createUrl(blob: Blob): string
  revokeUrl(url: string): void
  decode(url: string): Promise<HTMLImageElement>
  preview(image: HTMLImageElement): string | null
}

/**
 * The editor's images by asset id: their bytes, an object URL of them and the decoded image Konva
 * draws, loaded on first use from what was just imported or opened, or else from IndexedDB.
 * Assets that nothing uses any more are let go of, their object URLs revoked (see release).
 */
export class AssetCache {
  private entries = new Map<AssetId, Entry>()
  private listeners = new Set<() => void>()
  private readonly options: AssetCacheOptions

  constructor(options: AssetCacheOptions) {
    this.options = options
  }

  /** Bytes just imported or opened, so the asset needn't come from storage. */
  put(id: AssetId, blob: Blob): void {
    const entry = this.entries.get(id)
    if (entry) entry.blob ??= blob
    else this.entries.set(id, { blob, url: null, state: IDLE })
  }

  /** The asset's bytes: from memory, or else from storage; null when they are nowhere. */
  async blob(id: AssetId): Promise<Blob | null> {
    const known = this.entries.get(id)?.blob
    if (known) return known
    return (await this.options.load(id)) ?? null
  }

  /** How the asset shows now; the same object until that changes. */
  state(id: AssetId): AssetState {
    return this.entries.get(id)?.state ?? IDLE
  }

  /** Starts loading the asset to draw it, unless it is loading or loaded already. */
  request(id: AssetId): void {
    let entry = this.entries.get(id)
    if (!entry) {
      entry = { blob: null, url: null, state: IDLE }
      this.entries.set(id, entry)
    }
    if (entry.state.status !== 'idle') return
    void this.load(id, entry)
  }

  /** Resolves once each asset is drawable or known to be missing, loading those that aren't. */
  async whenSettled(ids: Iterable<AssetId>): Promise<void> {
    const waits = [...new Set(ids)].map(
      (id) =>
        new Promise<void>((resolve) => {
          const settled = () => {
            const { status } = this.state(id)
            return status === 'ready' || status === 'missing'
          }
          if (settled()) return resolve()
          const stop = this.subscribe(() => {
            if (!settled()) return
            stop()
            resolve()
          })
          this.request(id)
        }),
    )
    await Promise.all(waits)
  }

  private async load(id: AssetId, entry: Entry): Promise<void> {
    this.update(entry, LOADING)
    const { createUrl, revokeUrl, decode, preview } = this.options
    const current = () => this.entries.get(id) === entry
    try {
      entry.blob ??= (await this.options.load(id)) ?? null
      if (!current()) return
      if (!entry.blob) {
        this.update(entry, MISSING)
        return
      }
      const url = createUrl(entry.blob)
      entry.url = url
      const image = await decode(url)
      // Let go of while it loaded.
      if (!current()) {
        revokeUrl(url)
        return
      }
      this.update(entry, { status: 'ready', image, preview: preview(image) })
    } catch {
      if (current()) this.update(entry, MISSING)
    }
  }

  private update(entry: Entry, state: AssetState): void {
    entry.state = state
    this.listeners.forEach((listener) => listener())
  }

  /**
   * Lets go of every asset not in `used`: its decoded image, its bytes in memory and its object
   * URL, which is revoked. Assets still stored come back from storage if they are needed again.
   */
  release(used: ReadonlySet<AssetId>): void {
    let changed = false
    for (const [id, entry] of this.entries) {
      if (used.has(id)) continue
      if (entry.url !== null) this.options.revokeUrl(entry.url)
      this.entries.delete(id)
      changed = true
    }
    if (changed) this.listeners.forEach((listener) => listener())
  }

  /** The assets held in memory now. */
  held(): AssetId[] {
    return [...this.entries.keys()]
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}

// Page thumbnails are about 112 px wide, so twice that is plenty.
const PREVIEW_SIDE = 256

/** A small PNG of the image as a data: URL, for SVG thumbnails, which can't load object URLs. */
function previewOf(image: HTMLImageElement): string | null {
  try {
    const scale = Math.min(1, PREVIEW_SIDE / Math.max(image.naturalWidth, image.naturalHeight))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale))
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale))
    const context = canvas.getContext('2d')
    if (!context) return null
    context.drawImage(image, 0, 0, canvas.width, canvas.height)
    return canvas.toDataURL('image/png')
  } catch {
    return null
  }
}

// How long a loaded image waits to be decoded before it is drawn all the same: Chrome holds
// decode() back until the page draws a frame, which a hidden page doesn't.
const DECODE_WAIT_MS = 500

async function decodeImage(url: string): Promise<HTMLImageElement> {
  const image = new Image()
  await new Promise((resolve, reject) => {
    image.onload = resolve
    image.onerror = reject
    image.src = url
  })
  // Decoded off the main thread, so drawing it the first time doesn't stall the editor.
  await Promise.race([
    image.decode().catch(() => {}),
    new Promise((resolve) => setTimeout(resolve, DECODE_WAIT_MS)),
  ])
  return image
}

/** The editor's asset cache. */
export const assetCache = new AssetCache({
  load: (id) => loadAsset(id),
  createUrl: (blob) => URL.createObjectURL(blob),
  revokeUrl: (url) => URL.revokeObjectURL(url),
  decode: decodeImage,
  preview: previewOf,
})

/** How the asset shows, re-rendering as it loads; starts loading it. */
export function useAsset(id: AssetId): AssetState {
  useEffect(() => assetCache.request(id), [id])
  return useSyncExternalStore(assetCache.subscribe, () => assetCache.state(id))
}

interface UsageState {
  doc: Doc
  past: Doc[]
  future: Doc[]
  gestureStart: Doc | null
  clipboard: VectorNode[]
}

/** The assets the doc, its undo and redo history, an open gesture and the clipboard show. */
export function assetsInUse({
  doc,
  past,
  future,
  gestureStart,
  clipboard,
}: UsageState): Set<AssetId> {
  const used = new Set<AssetId>()
  const docs = [doc, ...past, ...future, ...(gestureStart ? [gestureStart] : [])]
  for (const d of docs) for (const id of referencedAssets(d.nodes)) used.add(id)
  for (const node of clipboard) if (node.type === 'image') used.add(node.assetId)
  return used
}

// How long after a change the cache lets go of what nothing uses: no hurry, and drags change
// the doc many times a second.
export const RELEASE_DELAY_MS = 1000

interface UsageStore {
  getState(): UsageState
  subscribe(listener: (state: UsageState, previous: UsageState) => void): () => void
}

/**
 * Lets go of assets once neither the doc, nor its undo or redo history, nor the clipboard shows
 * them, revoking their object URLs: a little after each change to any of these. Returns a
 * function that stops it.
 */
export function startAssetTracking(
  store: UsageStore,
  cache: AssetCache = assetCache,
  delay = RELEASE_DELAY_MS,
): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined
  const unsubscribe = store.subscribe((state, previous) => {
    if (
      state.doc === previous.doc &&
      state.past === previous.past &&
      state.future === previous.future &&
      state.clipboard === previous.clipboard
    )
      return
    clearTimeout(timer)
    timer = setTimeout(() => cache.release(assetsInUse(store.getState())), delay)
  })
  return () => {
    clearTimeout(timer)
    unsubscribe()
  }
}

let persistAsked = false

/**
 * Asks the browser once to keep this site's storage under pressure, so stored images aren't
 * evicted. Some browsers ask the user; others decide by themselves. Missing outside secure
 * contexts.
 */
export function askToPersistStorage(): void {
  if (persistAsked) return
  persistAsked = true
  try {
    const storage = navigator.storage
    if (!storage?.persist) return
    void storage
      .persisted()
      .then((already) => (already ? true : storage.persist()))
      .catch(() => false)
  } catch {
    // Nothing to do: the images are stored all the same.
  }
}
