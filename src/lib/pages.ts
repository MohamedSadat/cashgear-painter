import type { Doc, NodeId, Page, VectorNode } from '../types'

export const MIN_PAGE_SIZE = 16
export const MAX_PAGE_SIZE = 8000
/** CSS pixels per millimetre: 96 per inch. */
export const PX_PER_MM = 96 / 25.4

/** Millimetres as whole pixels, the page sizes the model holds. */
export const mmToPx = (mm: number) => Math.round(mm * PX_PER_MM)
/** Pixels as millimetres, to a tenth. */
export const pxToMm = (px: number) => Math.round((px / PX_PER_MM) * 10) / 10

/** A page side as whole pixels between MIN_PAGE_SIZE and MAX_PAGE_SIZE. */
export function clampPageSize(n: number): number {
  if (!Number.isFinite(n)) return MIN_PAGE_SIZE
  return Math.min(MAX_PAGE_SIZE, Math.max(MIN_PAGE_SIZE, Math.round(n)))
}

export interface PagePreset {
  id: string
  label: string
  width: number // portrait, or as named
  height: number
  print: boolean // sized in mm in the UI
}

export const PAGE_PRESETS: readonly PagePreset[] = [
  { id: 'a4', label: 'A4', width: 794, height: 1123, print: true },
  { id: 'letter', label: 'US Letter', width: 816, height: 1056, print: true },
  { id: 'square', label: 'Square post', width: 1080, height: 1080, print: false },
  { id: 'story', label: 'Story', width: 1080, height: 1920, print: false },
  { id: 'presentation', label: 'Presentation', width: 1920, height: 1080, print: false },
  { id: 'painter', label: 'Painter v2', width: 1600, height: 1000, print: false },
]

/**
 * The preset a page size is, as named or turned a quarter: A4 landscape is A4 with `turned`. A
 * preset that matches as named wins, so 1920 × 1080 is Presentation, not a turned Story.
 */
export function presetOf(
  width: number,
  height: number,
): { preset: PagePreset; turned: boolean } | null {
  const named = PAGE_PRESETS.find((p) => p.width === width && p.height === height)
  if (named) return { preset: named, turned: false }
  const turned = PAGE_PRESETS.find((p) => p.width === height && p.height === width)
  return turned ? { preset: turned, turned: true } : null
}

/** "Page N", one past the highest such name and past the page count. */
export function nextPageName(pages: readonly Page[]): string {
  let n = pages.length
  for (const page of pages) {
    const match = /^Page (\d+)$/.exec(page.name)
    if (match) n = Math.max(n, Number(match[1]))
  }
  return `Page ${n + 1}`
}

export function pageById(doc: Doc, id: string): Page | undefined {
  return doc.pages.find((page) => page.id === id)
}

// Keyed by the pages array: any change to a page's roots gives the doc a new one.
const rootPages = new WeakMap<readonly Page[], Map<NodeId, string>>()

/** Each top-level node's page. Never called on an immer draft. */
export function rootPageMap(doc: Doc): Map<NodeId, string> {
  let map = rootPages.get(doc.pages)
  if (!map) {
    map = new Map()
    for (const page of doc.pages) for (const id of page.rootIds) map.set(id, page.id)
    rootPages.set(doc.pages, map)
  }
  return map
}

/** The page a node is on, through its groups; null when it is on none. */
export function pageOf(doc: Doc, id: NodeId): string | null {
  let node: VectorNode | undefined = doc.nodes[id]
  while (node && node.parentId !== null) node = doc.nodes[node.parentId]
  return node ? (rootPageMap(doc).get(node.id) ?? null) : null
}

const subtrees = new WeakMap<Doc, Map<string, VectorNode[]>>()

/** Every node on a page in z-order, bottom to top, each group before its children. */
export function pageSubtree(doc: Doc, pageId: string): VectorNode[] {
  let byPage = subtrees.get(doc)
  if (!byPage) {
    byPage = new Map()
    subtrees.set(doc, byPage)
  }
  let nodes = byPage.get(pageId)
  if (!nodes) {
    const out: VectorNode[] = []
    const visit = (id: NodeId) => {
      const node = doc.nodes[id]
      if (!node) return
      out.push(node)
      if (node.type === 'group') node.childIds.forEach(visit)
    }
    pageById(doc, pageId)?.rootIds.forEach(visit)
    nodes = out
    byPage.set(pageId, nodes)
  }
  return nodes
}

/**
 * The pages of `to` that differ from `from`: new ones, ones whose size, background, name or
 * object list changed, and ones holding a node that changed. In `to`'s order.
 */
export function touchedPages(from: Doc, to: Doc): string[] {
  if (from === to) return []
  return to.pages
    .filter((page) => {
      const before = pageById(from, page.id)
      if (before !== page) return true
      if (from.nodes === to.nodes) return false
      // A node added or removed changes its parent's list, so comparing what `to` holds is enough.
      return pageSubtree(to, page.id).some((node) => from.nodes[node.id] !== node)
    })
    .map((page) => page.id)
}
