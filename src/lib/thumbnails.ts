import { useSyncExternalStore } from 'react'
import type { AssetId, Doc } from '../types'
import { assetCache } from './images/assets'
import { pageSubtree } from './pages'
import { exportSvg } from './svg/exportSvg'

export const THUMBNAIL_DELAY_MS = 1000

interface ThumbnailState {
  doc: Doc
  currentPageId: string
}

/** The slice of the editor store thumbnails need; tests pass a small one. */
interface ThumbnailStore {
  getState(): ThumbnailState
  subscribe(listener: (state: ThumbnailState, previous: ThumbnailState) => void): () => void
}

/** Draws a page as an image URL. */
export type RenderPage = (doc: Doc, pageId: string) => string

// The page's SVG export: the same drawing as the canvas, without a second Konva stage, and
// cheap, since stroke outlines and path data come from their caches. An SVG shown as an image
// can't load object URLs, so images go in as their small previews, gray boxes until they load.
const svgUrl: RenderPage = (doc, pageId) => {
  const svg = exportSvg(doc, pageId, { imageHref: (asset) => assetCache.state(asset.id).preview })
  return URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }))
}

const urls = new Map<string, string>()
// What each thumbnail was drawn from: the page and every node on it, compared by identity.
const drawnFrom = new Map<string, readonly unknown[]>()
const listeners = new Set<() => void>()

const sameParts = (a: readonly unknown[], b: readonly unknown[]) =>
  a.length === b.length && a.every((part, i) => part === b[i])

/** What thumbnails need of the images: how one shows now, and word when that changes. */
interface ImageSource {
  state(id: AssetId): unknown // a new value whenever the image shows differently
  request(id: AssetId): void
  subscribe(listener: () => void): () => void
}

interface ThumbnailOptions {
  render?: RenderPage
  revoke?: (url: string) => void
  delay?: number
  images?: ImageSource
}

/**
 * Keeps an image of every page for the pages panel: drawn when the pages first show, redrawn
 * `delay` ms after the last edit for pages that changed or whose images loaded, right away for the
 * page just left, and right away for a new page. Returns a function that stops it and drops the
 * images.
 */
export function startThumbnails(
  store: ThumbnailStore,
  {
    render = svgUrl,
    revoke = (url) => URL.revokeObjectURL(url),
    delay = THUMBNAIL_DELAY_MS,
    images = assetCache,
  }: ThumbnailOptions = {},
): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined

  /** What a page's thumbnail shows: the page, every node on it, and how its images show. */
  const partsOf = (doc: Doc, pageId: string): unknown[] => {
    const nodes = pageSubtree(doc, pageId)
    const parts: unknown[] = [doc.pages.find((page) => page.id === pageId), ...nodes]
    for (const node of nodes) {
      if (node.type !== 'image') continue
      images.request(node.assetId)
      parts.push(images.state(node.assetId))
    }
    return parts
  }

  /** Redraws the pages among `only` (all by default) whose content changed. */
  const refresh = (only?: ReadonlySet<string>) => {
    const { doc } = store.getState()
    let changed = false
    for (const page of doc.pages) {
      if (only && !only.has(page.id)) continue
      const parts = partsOf(doc, page.id)
      const before = drawnFrom.get(page.id)
      if (before && sameParts(before, parts)) continue
      const old = urls.get(page.id)
      urls.set(page.id, render(doc, page.id))
      drawnFrom.set(page.id, parts)
      if (old !== undefined) revoke(old)
      changed = true
    }
    if (!only) {
      const kept = new Set(doc.pages.map((page) => page.id))
      for (const [id, url] of urls) {
        if (kept.has(id)) continue
        revoke(url)
        urls.delete(id)
        drawnFrom.delete(id)
        changed = true
      }
    }
    if (changed) listeners.forEach((listener) => listener())
  }

  // After the first render, so a large drawing doesn't hold up the editor showing.
  timer = setTimeout(() => refresh(), 0)
  const unsubscribe = store.subscribe((state, previous) => {
    if (state.currentPageId !== previous.currentPageId) {
      refresh(new Set([previous.currentPageId]))
    }
    if (state.doc === previous.doc) return
    const fresh = state.doc.pages.filter((page) => !urls.has(page.id)).map((page) => page.id)
    if (fresh.length > 0) refresh(new Set(fresh))
    clearTimeout(timer)
    timer = setTimeout(() => refresh(), delay)
  })
  // An image that loads changes the pages showing it.
  const stopImages = images.subscribe(() => {
    clearTimeout(timer)
    timer = setTimeout(() => refresh(), delay)
  })

  return () => {
    clearTimeout(timer)
    unsubscribe()
    stopImages()
    for (const url of urls.values()) revoke(url)
    urls.clear()
    drawnFrom.clear()
    listeners.forEach((listener) => listener())
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** The page's thumbnail URL; null until it is drawn. */
export function thumbnailOf(pageId: string): string | null {
  return urls.get(pageId) ?? null
}

/** The page's thumbnail URL, re-rendering when it is redrawn; null until it is drawn. */
export function useThumbnail(pageId: string): string | null {
  return useSyncExternalStore(subscribe, () => thumbnailOf(pageId))
}
