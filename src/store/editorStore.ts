import { produce, type Draft } from 'immer'
import { create } from 'zustand'
import { isIdentity } from '../lib/geometry/bounds'
import { shapeAnchors } from '../lib/geometry/pathData'
import { WEB_SAFE_FONTS } from '../lib/geometry/textLayout'
import {
  absoluteTransform,
  composeTransform,
  deltaInParent,
  relativeTransform,
  scaleContent,
} from '../lib/geometry/transform'
import {
  clampPageSize,
  nextPageName,
  pageById,
  pageOf,
  rootPageMap,
  touchedPages,
} from '../lib/pages'
import { samePaint, solid } from '../lib/paint/paint'
import {
  FIRST_PAGE_ID,
  IDENTITY_TRANSFORM,
  emptyDoc,
  newPage,
  type Anchor,
  type Contour,
  type Doc,
  type FillRule,
  type GroupNode,
  type NodeId,
  type NodeOf,
  type Page,
  type Paint,
  type PathNode,
  type Point,
  type StrokeNode,
  type Style,
  type TextNode,
  type ToolId,
  type VectorNode,
} from '../types'

export const HISTORY_LIMIT = 100
export const MIN_SIZE = 1
export const MAX_SIZE = 64
export const MIN_ZOOM = 0.1 // screen pixels per canvas unit
export const MAX_ZOOM = 32
// Nudges, and edits sharing a merge key (a slider drag, a color picker), this close together are
// one undo step.
export const MERGE_MS = 500
export const PASTE_OFFSET = 10 // canvas units between a copy and its duplicate or paste

/** The style new rectangles, ellipses and lines start with: a black outline and no fill. */
export const DEFAULT_SHAPE_STYLE: Style = {
  fill: null,
  stroke: '#000000',
  strokeWidth: 4,
  opacity: 1,
}

export const MIN_FONT_SIZE = 8
export const MAX_FONT_SIZE = 200

/** What a new text starts with: its color and font. */
export interface TextStyle {
  fill: string
  fontFamily: string
  fontSize: number
  fontStyle: TextNode['fontStyle']
  align: TextNode['align']
}

export const DEFAULT_TEXT_STYLE: TextStyle = {
  fill: '#000000',
  fontFamily: WEB_SAFE_FONTS[0].family,
  fontSize: 48,
  fontStyle: 'normal',
  align: 'left',
}

export type ZOrder = 'forward' | 'backward' | 'front' | 'back'

/** An axis-aligned rectangle in canvas units. */
export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface Brush {
  color: string
  size: number
}

/** What the eraser does: delete whole objects, or cut through freehand strokes. */
export type EraserMode = 'object' | 'split'

export interface View {
  scale: number // multiplies the viewport's fit scale; 1 = the page fits
  x: number // Stage position, in screen pixels
  y: number
}

/** The canvas area as measured, and the scale at which the current page fits it. */
export interface Viewport {
  width: number // Stage size, in screen pixels
  height: number
  boxWidth: number // the area inside the canvas's padding, which a fitted page fills
  boxHeight: number
  fit: number // derived from the box and the current page's size
}

/**
 * A page's zoom and pan while another page shows: the canvas point in the middle of the canvas
 * and the zoom relative to the fit, so a window resized in between keeps the same part in view.
 * The size the page had then: after a resize, it is fitted instead.
 */
export interface SavedView {
  scale: number
  cx: number
  cy: number
  width: number
  height: number
}

export interface Toast {
  id: number // a new id per message, so the same text shown twice still restarts its timer
  message: string
}

/** An anchor of a path, by the path's id, the contour's index and the anchor's index in it. */
export interface AnchorRef {
  id: NodeId
  contour: number
  index: number
}

export interface PageChanges {
  name?: string
  background?: Paint
}

export interface EditorState {
  doc: Doc
  currentPageId: string // the page on the canvas; not in history or autosave
  views: Record<string, SavedView> // other pages' zoom and pan, for when they show again
  selection: NodeId[]
  past: Doc[] // undo stack (snapshots)
  future: Doc[] // redo stack
  gestureStart: Doc | null // doc when the current drag began
  tool: ToolId
  brush: Brush
  eraserMode: EraserMode // not in history or autosave
  shapeStyle: Style // for new rects, ellipses and lines; not in history or autosave
  view: View // zoom and pan, not in history
  viewport: Viewport // measured canvas area; not in history or autosave
  draft: VectorNode | null // the node being drawn right now; not in history or autosave
  erasing: NodeId[] // nodes the eraser has touched in the current pass
  marquee: Rect | null // the select tool's drag rectangle
  clipboard: VectorNode[] // copied nodes with their descendants; not in history or autosave
  penHover: [x: number, y: number] | null // the pen's pointer while it hovers, in canvas units
  activeAnchor: AnchorRef | null // the direct-select tool's anchor, for Delete and the panel
  textStyle: TextStyle // for new text; not in history or autosave
  editingText: NodeId | null // the text the textarea overlay is editing
  toast: Toast | null // a short message, such as what an import skipped

  addNodes(nodes: VectorNode[], parentId?: NodeId): void
  replaceDoc(doc: Doc): void
  updateNodes(patch: Record<NodeId, Partial<VectorNode>>, mergeKey?: string): void
  deleteNodes(ids: NodeId[]): void
  splitStrokes(cuts: Record<NodeId, Point[][]>): void
  reorder(ids: NodeId[], where: ZOrder): void
  group(ids: NodeId[]): void
  ungroup(id: NodeId): void
  moveNodes(ids: NodeId[], parentId: NodeId | null, index: number): void
  nudge(ids: NodeId[], dx: number, dy: number): void
  duplicate(ids: NodeId[]): void
  copy(ids: NodeId[]): void
  paste(): void
  convertToPath(ids: NodeId[]): void
  beginGesture(): void
  endGesture(): void
  cancelGesture(): void
  undo(): void
  redo(): void
  clear(): void
  select(ids: NodeId[], mode?: 'replace' | 'add' | 'toggle'): void
  setTool(t: ToolId): void
  setBrush(brush: Partial<Brush>): void
  setEraserMode(mode: EraserMode): void
  setShapeStyle(style: Partial<Style>): void
  setDraft(node: VectorNode | null): void
  setErasing(ids: NodeId[]): void
  setMarquee(rect: Rect | null): void
  setPenHover(point: [number, number] | null): void
  setActiveAnchor(anchor: AnchorRef | null): void
  setTextStyle(style: Partial<TextStyle>): void
  setEditingText(id: NodeId | null): void
  showToast(message: string): void
  dismissToast(id: number): void
  setCurrentPage(id: string): void
  addPage(): void
  duplicatePage(id: string): void
  deletePage(id: string): void
  movePage(id: string, index: number): void
  resizePage(id: string, width: number, height: number, scaleContent?: boolean): void
  updatePage(id: string, changes: PageChanges, mergeKey?: string): void
  moveToPage(ids: NodeId[], pageId: string, copy: boolean): void
  setViewport(size: Omit<Viewport, 'fit'>): void
  setView(view: View): void
  zoomTo(zoom: number, anchor?: [x: number, y: number]): void
  panBy(dx: number, dy: number): void
  fitView(): void
}

// crypto.randomUUID() is missing on plain-http LAN URLs (npm run dev -- --host), so ids are built by hand.
let idCounter = 0
export function newNodeId(): string {
  idCounter += 1
  return `${Date.now().toString(36)}-${idCounter.toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/** A freehand stroke at the top level: the brush color fills its outline. */
export function createStrokeNode(
  points: Point[],
  { color, size, usesPressure }: { color: string; size: number; usesPressure: boolean },
  id: NodeId = newNodeId(),
): StrokeNode {
  return {
    id,
    type: 'stroke',
    name: 'Stroke',
    parentId: null,
    transform: IDENTITY_TRANSFORM,
    style: { fill: solid(color), stroke: null, strokeWidth: 0, opacity: 1 },
    hidden: false,
    locked: false,
    points,
    size,
    usesPressure,
  }
}

/** The fields every new top-level node starts with, placed at (x, y). */
function newBase(id: NodeId, name: string, style: Style, x: number, y: number) {
  return {
    id,
    name,
    parentId: null,
    transform: { ...IDENTITY_TRANSFORM, x, y },
    style,
    hidden: false,
    locked: false,
  }
}

/** A rectangle filling `box`, placed at its top-left corner. */
export function createRectNode(box: Rect, style: Style, id: NodeId = newNodeId()): NodeOf<'rect'> {
  return {
    ...newBase(id, 'Rectangle', style, box.x, box.y),
    type: 'rect',
    width: box.width,
    height: box.height,
    cornerRadius: 0,
  }
}

/** The ellipse inside `box`, placed at its center. */
export function createEllipseNode(
  box: Rect,
  style: Style,
  id: NodeId = newNodeId(),
): NodeOf<'ellipse'> {
  return {
    ...newBase(id, 'Ellipse', style, box.x + box.width / 2, box.y + box.height / 2),
    type: 'ellipse',
    rx: box.width / 2,
    ry: box.height / 2,
  }
}

/** A line from `from` to `to` without arrowheads, placed at `from`. */
export function createLineNode(
  from: readonly [number, number],
  to: readonly [number, number],
  style: Style,
  id: NodeId = newNodeId(),
): NodeOf<'line'> {
  return {
    ...newBase(id, 'Line', style, from[0], from[1]),
    type: 'line',
    points: [0, 0, to[0] - from[0], to[1] - from[1]],
    arrowStart: false,
    arrowEnd: false,
  }
}

/**
 * A path of one or more contours whose anchors are given in canvas units, placed at the first
 * anchor of the first.
 */
export function createPathFromContours(
  contours: Contour[],
  style: Style,
  fillRule: FillRule = 'nonzero',
  id: NodeId = newNodeId(),
): PathNode {
  const first = contours[0]?.anchors[0]
  const [x, y] = first ? [first.x, first.y] : [0, 0]
  return {
    ...newBase(id, 'Path', style, x, y),
    type: 'path',
    contours: contours.map((c) => ({
      ...c,
      anchors: c.anchors.map((a) => ({ ...a, x: a.x - x, y: a.y - y })),
    })),
    fillRule,
  }
}

/** A path of one contour through anchors given in canvas units, placed at the first anchor. */
export function createPathNode(
  anchors: Anchor[],
  closed: boolean,
  style: Style,
  id: NodeId = newNodeId(),
): PathNode {
  return createPathFromContours([{ anchors, closed }], style, 'nonzero', id)
}

/** A text box `width` units wide with its top-left corner at (x, y), in the text style. */
export function createTextNode(
  x: number,
  y: number,
  width: number,
  style: TextStyle,
  text = '',
  id: NodeId = newNodeId(),
): TextNode {
  const { fill, fontFamily, fontSize, fontStyle, align } = style
  return {
    ...newBase(id, 'Text', { fill: solid(fill), stroke: null, strokeWidth: 0, opacity: 1 }, x, y),
    type: 'text',
    text,
    fontFamily,
    fontSize,
    fontStyle,
    align,
    width,
  }
}

/** A group around `childIds`, with no transform of its own, so its children stay where they are. */
export function createGroupNode(
  childIds: NodeId[],
  parentId: NodeId | null = null,
  id: NodeId = newNodeId(),
): GroupNode {
  return {
    id,
    type: 'group',
    name: 'Group',
    parentId,
    transform: IDENTITY_TRANSFORM,
    style: { fill: null, stroke: null, strokeWidth: 0, opacity: 1 },
    hidden: false,
    locked: false,
    childIds,
  }
}

/**
 * Whether the node is on the page, and it and every group it is in are visible and unlocked: it
 * can be picked.
 */
export function isPickable(doc: Doc, id: NodeId, pageId: string): boolean {
  let node: VectorNode | undefined = doc.nodes[id]
  while (node) {
    if (node.hidden || node.locked) return false
    if (node.parentId === null) return rootPageMap(doc).get(node.id) === pageId
    node = doc.nodes[node.parentId]
  }
  return false
}

/** Whether `ancestor` is `id` or one of the groups it is in. */
export function isWithin(doc: Doc, id: NodeId, ancestor: NodeId): boolean {
  let node: VectorNode | undefined = doc.nodes[id]
  while (node) {
    if (node.id === ancestor) return true
    node = node.parentId === null ? undefined : doc.nodes[node.parentId]
  }
  return false
}

/**
 * Every node's place in a walk of the tree: page by page, bottom to top, each group before its
 * children.
 */
function treeOrder(doc: Doc): Map<NodeId, number> {
  const order = new Map<NodeId, number>()
  const visit = (id: NodeId) => {
    const node = doc.nodes[id]
    if (!node || order.has(id)) return
    order.set(id, order.size)
    if (node.type === 'group') node.childIds.forEach(visit)
  }
  for (const page of doc.pages) page.rootIds.forEach(visit)
  return order
}

/**
 * The existing nodes among `ids` without the ones inside another of them, in tree order: what a
 * move, a group or a duplicate acts on, since a group carries its children along.
 */
export function outermost(doc: Doc, ids: NodeId[]): NodeId[] {
  const picked = new Set(ids.filter((id) => id in doc.nodes))
  const order = treeOrder(doc)
  return [...picked]
    .filter((id) => {
      for (let p = doc.nodes[id].parentId; p !== null; p = doc.nodes[p]?.parentId ?? null) {
        if (picked.has(p)) return false
      }
      return order.has(id)
    })
    .sort((a, b) => order.get(a)! - order.get(b)!)
}

/** A page's top-level z-order list; a throwaway one for a page that doesn't exist. */
function rootsOf(doc: Draft<Doc>, pageId: string): NodeId[] {
  return doc.pages.find((page) => page.id === pageId)?.rootIds ?? []
}

/** The z-order list a node with this parent goes into: a page's roots, or a group's children. */
function childList(doc: Draft<Doc>, parentId: NodeId | null, pageId: string): NodeId[] {
  if (parentId === null) return rootsOf(doc, pageId)
  const parent = doc.nodes[parentId]
  return parent?.type === 'group' ? parent.childIds : []
}

/** The z-order list the node sits in: its page's roots, or its group's children. */
function siblingsOf(doc: Draft<Doc>, id: NodeId): NodeId[] {
  const node = doc.nodes[id]
  if (!node) return []
  if (node.parentId === null) {
    return doc.pages.find((page) => page.rootIds.includes(id))?.rootIds ?? []
  }
  const parent = doc.nodes[node.parentId]
  return parent?.type === 'group' ? parent.childIds : []
}

/** Takes a node out of its parent's z-order, leaving it in the node map. */
function detach(doc: Draft<Doc>, id: NodeId): void {
  const siblings = siblingsOf(doc, id)
  const index = siblings.indexOf(id)
  if (index >= 0) siblings.splice(index, 1)
}

/** Deletes the groups among `ids` that have nothing left inside, and parents that empty in turn. */
function dropEmptyGroups(doc: Draft<Doc>, ids: Iterable<NodeId | null>): void {
  for (let id of ids) {
    while (id !== null) {
      const node: Draft<VectorNode> | undefined = doc.nodes[id]
      if (node?.type !== 'group' || node.childIds.length > 0) break
      const parentId = node.parentId
      detach(doc, id)
      delete doc.nodes[id]
      id = parentId
    }
  }
}

type ConvertibleNode = NodeOf<'rect' | 'ellipse' | 'line'>

const DEFAULT_NAMES: Record<ConvertibleNode['type'], string> = {
  rect: 'Rectangle',
  ellipse: 'Ellipse',
  line: 'Line',
}

export const canConvertToPath = (node: VectorNode): node is ConvertibleNode =>
  node.type === 'rect' || node.type === 'ellipse' || node.type === 'line'

/**
 * The shape as a path that looks the same, under the same id, transform and style; a default name
 * becomes 'Path'. A line's arrowheads are dropped.
 */
export function shapeToPath(node: ConvertibleNode): PathNode {
  const { id, name, parentId, transform, style, hidden, locked } = node
  return {
    id,
    name: name === DEFAULT_NAMES[node.type] ? 'Path' : name,
    parentId,
    transform,
    style,
    hidden,
    locked,
    type: 'path',
    contours: [shapeAnchors(node)],
    fillRule: 'nonzero',
  }
}

function pushSnapshot(past: Doc[], doc: Doc): Doc[] {
  const next = [...past, doc]
  return next.length > HISTORY_LIMIT ? next.slice(next.length - HISTORY_LIMIT) : next
}

/**
 * Selected ids that can still be picked in `doc` on the page: they exist there, and neither they
 * nor their groups are hidden or locked. The same array when nothing was dropped.
 */
function pickable(selection: NodeId[], doc: Doc, pageId: string): NodeId[] {
  const kept = selection.filter((id) => isPickable(doc, id, pageId))
  return kept.length === selection.length ? selection : kept
}

export function clampSize(n: number): number {
  if (!Number.isFinite(n)) return MIN_SIZE
  return Math.min(MAX_SIZE, Math.max(MIN_SIZE, Math.round(n)))
}

export function clampOpacity(n: number): number {
  if (!Number.isFinite(n)) return 1
  return Math.min(1, Math.max(0, n))
}

export function clampZoom(zoom: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom))
}

/** Screen pixels per canvas unit: the Stage scale. */
export function zoomOf({ view, viewport }: Pick<EditorState, 'view' | 'viewport'>): number {
  return viewport.fit * view.scale
}

/** The nodes and every descendant, in z-order (bottom to top), parents before their children. */
function collectSubtrees(doc: Doc, ids: NodeId[]): VectorNode[] {
  const wanted = new Set(ids)
  const out: VectorNode[] = []
  const visit = (id: NodeId, take: boolean) => {
    const node = doc.nodes[id]
    if (!node) return
    const inside = take || wanted.has(id)
    if (inside) out.push(node)
    if (node.type === 'group') node.childIds.forEach((child) => visit(child, inside))
  }
  for (const page of doc.pages) page.rootIds.forEach((id) => visit(id, false))
  return out
}

/**
 * Copies of the nodes under new ids, with parent and child ids remapped. A node whose parent is
 * not among them is a root of the copy: it goes into the same group when that group is in `doc`
 * (a duplicate), or else to the top level (a paste), and moves by `offset` canvas units on both
 * axes.
 */
function withNewIds(
  doc: Doc,
  nodes: VectorNode[],
  offset: number,
): { nodes: VectorNode[]; roots: NodeId[] } {
  const ids = new Map(nodes.map((node) => [node.id, newNodeId()]))
  const roots: NodeId[] = []
  const copies = nodes.map((node): VectorNode => {
    const id = ids.get(node.id)!
    let parentId = node.parentId === null ? null : (ids.get(node.parentId) ?? null)
    let transform = node.transform
    if (parentId === null) {
      roots.push(id)
      const parent = node.parentId === null ? undefined : doc.nodes[node.parentId]
      parentId = parent?.type === 'group' ? parent.id : null
      const [dx, dy] =
        parentId === null ? [offset, offset] : deltaInParent(doc.nodes, node.id, offset, offset)
      transform = { ...transform, x: transform.x + dx, y: transform.y + dy }
    }
    const copy = { ...node, id, parentId, transform }
    if (copy.type === 'group') {
      copy.childIds = copy.childIds.flatMap((child) => {
        const mapped = ids.get(child)
        return mapped === undefined ? [] : [mapped]
      })
    }
    return copy
  })
  return { nodes: copies, roots }
}

/** A sibling list with the picked ids moved one step or all the way up or down, keeping their order. */
export function reorderIds(list: NodeId[], picked: ReadonlySet<NodeId>, where: ZOrder): NodeId[] {
  const isPicked = (id: NodeId) => picked.has(id)
  if (where === 'front') return [...list.filter((id) => !isPicked(id)), ...list.filter(isPicked)]
  if (where === 'back') return [...list.filter(isPicked), ...list.filter((id) => !isPicked(id))]
  const out = [...list]
  // Walking against the direction of travel moves a run of picked ids together.
  if (where === 'forward') {
    for (let i = out.length - 2; i >= 0; i--) {
      if (isPicked(out[i]) && !isPicked(out[i + 1])) [out[i], out[i + 1]] = [out[i + 1], out[i]]
    }
  } else {
    for (let i = 1; i < out.length; i++) {
      if (isPicked(out[i]) && !isPicked(out[i - 1])) [out[i], out[i - 1]] = [out[i - 1], out[i]]
    }
  }
  return out
}

const sameOrder = (a: NodeId[], b: NodeId[]) =>
  a.length === b.length && a.every((id, i) => id === b[i])

/** The page on the canvas: the current one, or the first when the id is stale. */
export function currentPageOf({ doc, currentPageId }: Pick<EditorState, 'doc' | 'currentPageId'>) {
  return pageById(doc, currentPageId) ?? doc.pages[0]
}

/** The scale at which the page fits the viewport's box; 0 before the canvas is measured. */
export function fitFor(
  { boxWidth, boxHeight }: Pick<Viewport, 'boxWidth' | 'boxHeight'>,
  page: Pick<Page, 'width' | 'height'>,
): number {
  if (boxWidth <= 0 || boxHeight <= 0) return 0
  return Math.min(boxWidth / page.width, boxHeight / page.height)
}

/** The view that centers the whole page in the viewport. */
function fittedView({ width, height, fit }: Viewport, page: Page): View {
  return {
    scale: 1,
    x: (width - page.width * fit) / 2,
    y: (height - page.height * fit) / 2,
  }
}

function saveView({ width, height, fit }: Viewport, view: View, page: Page): SavedView {
  const zoom = fit * view.scale
  return {
    scale: view.scale,
    cx: (width / 2 - view.x) / zoom,
    cy: (height / 2 - view.y) / zoom,
    width: page.width,
    height: page.height,
  }
}

function restoreView({ width, height, fit }: Viewport, saved: SavedView): View {
  const zoom = fit * saved.scale
  return { scale: saved.scale, x: width / 2 - saved.cx * zoom, y: height / 2 - saved.cy * zoom }
}

/**
 * The page to show once the doc changes from `from` to `to`. `switchTo` names it outright. A page
 * that went away hands over to the page before it in `from`, or else the one after, so undoing an
 * added page goes back where it was added from. With `follow` (undo and redo), a change made on
 * another page takes the canvas there, so it doesn't happen out of sight.
 */
function pageAfter(
  currentPageId: string,
  from: Doc,
  to: Doc,
  { switchTo, follow = false }: { switchTo?: string; follow?: boolean },
): string {
  if (switchTo !== undefined && pageById(to, switchTo)) return switchTo
  if (pageById(to, currentPageId)) {
    if (!follow) return currentPageId
    const touched = touchedPages(from, to)
    return touched.length > 0 && !touched.includes(currentPageId) ? touched[0] : currentPageId
  }
  const index = from.pages.findIndex((page) => page.id === currentPageId)
  const before = from.pages.slice(0, Math.max(0, index)).reverse()
  const after = index < 0 ? [] : from.pages.slice(index + 1)
  return [...before, ...after].find((page) => pageById(to, page.id))?.id ?? to.pages[0].id
}

type PageState = Pick<
  EditorState,
  'currentPageId' | 'views' | 'viewport' | 'view' | 'selection' | 'activeAnchor'
>

/**
 * The page-related UI state for showing page `pageId` of `to` in place of the current page of
 * `state.doc`. Another page saves this one's view and brings back that one's, or fits it, and
 * starts with nothing selected. The same page keeps its view and the selection still on it,
 * unless its size changed: then it is fitted again.
 */
function showPage(state: EditorState, to: Doc, pageId: string): PageState {
  const { doc, currentPageId, views, viewport, view, selection, activeAnchor } = state
  const before = pageById(doc, currentPageId)
  const page = pageById(to, pageId) ?? to.pages[0]
  const fit = fitFor(viewport, page)
  const fitted = fit === viewport.fit ? viewport : { ...viewport, fit }
  if (page.id === currentPageId) {
    const resized = !before || before.width !== page.width || before.height !== page.height
    const kept = pickable(selection, to, page.id)
    return {
      currentPageId,
      views,
      viewport: fitted,
      view: resized && fit > 0 ? fittedView(fitted, page) : view,
      selection: kept,
      activeAnchor: activeAnchor && kept.includes(activeAnchor.id) ? activeAnchor : null,
    }
  }
  const saved = before && viewport.fit > 0 ? { [before.id]: saveView(viewport, view, before) } : {}
  const restore = views[page.id]
  let next = view
  if (fit > 0) {
    next =
      restore && restore.width === page.width && restore.height === page.height
        ? restoreView(fitted, restore)
        : fittedView(fitted, page)
  }
  return {
    currentPageId: page.id,
    views: { ...views, ...saved },
    viewport: fitted,
    view: next,
    selection: [],
    activeAnchor: null,
  }
}

export const useEditorStore = create<EditorState>()((set, get) => {
  /**
   * The page state for a doc that replaces the current one: the page `pageAfter` picks, and the
   * selection pruned to what can still be picked there. Hiding or locking a node drops it from the
   * selection, as deleting it does.
   */
  function settle(
    from: Doc,
    to: Doc,
    options: { switchTo?: string; follow?: boolean } = {},
  ): PageState | Pick<EditorState, 'selection'> {
    const state = get()
    if (from.pages === to.pages && options.switchTo === undefined && !options.follow) {
      return { selection: pickable(state.selection, to, state.currentPageId) }
    }
    return showPage(state, to, pageAfter(state.currentPageId, from, to, options))
  }

  /**
   * Applies one edit to the doc. Outside a gesture it is one history step; inside one, the step
   * is recorded once at endGesture. An edit that changes nothing records nothing. `merge` folds
   * the edit into the latest step instead; `switchTo` shows that page afterwards.
   */
  function commit(
    recipe: (doc: Draft<Doc>) => void,
    { merge = false, switchTo }: { merge?: boolean; switchTo?: string } = {},
  ): void {
    const { doc, past, gestureStart } = get()
    const next = produce(doc, recipe)
    if (next === doc) return
    const pageState = settle(doc, next, { switchTo })
    if (gestureStart || merge) set({ doc: next, ...pageState })
    else set({ doc: next, past: pushSnapshot(past, doc), future: [], ...pageState })
  }

  /** Adds copies of the nodes on top of their groups' or the page's z-order, and selects them. */
  function insertCopies(nodes: VectorNode[], offset: number): void {
    const { doc, currentPageId } = get()
    const copies = withNewIds(doc, nodes, offset)
    if (copies.roots.length === 0) return
    commit((draft) => {
      for (const node of copies.nodes) draft.nodes[node.id] = node
      for (const id of copies.roots) {
        childList(draft, draft.nodes[id].parentId, currentPageId).push(id)
      }
    })
    set({ selection: copies.roots })
  }

  // The doc the last mergeable edit produced, its key, and when: an edit with the same key soon
  // after, with no other edit between, merges into it.
  let lastMerge: { key: string; at: number; doc: Doc } | null = null
  function commitMerging(key: string, recipe: (doc: Draft<Doc>) => void): void {
    const now = Date.now()
    const merge =
      lastMerge !== null &&
      lastMerge.key === key &&
      lastMerge.doc === get().doc &&
      now - lastMerge.at < MERGE_MS
    commit(recipe, { merge })
    lastMerge = { key, at: now, doc: get().doc }
  }
  // Pastes since the last copy, so repeated pastes step away from the original.
  let pasteCount = 0
  let toastCount = 0

  return {
    doc: emptyDoc(),
    currentPageId: FIRST_PAGE_ID,
    views: {},
    selection: [],
    past: [],
    future: [],
    gestureStart: null,
    tool: 'brush',
    brush: { color: '#000000', size: 8 },
    eraserMode: 'object',
    shapeStyle: DEFAULT_SHAPE_STYLE,
    view: { scale: 1, x: 0, y: 0 },
    viewport: { width: 0, height: 0, boxWidth: 0, boxHeight: 0, fit: 0 },
    draft: null,
    erasing: [],
    marquee: null,
    clipboard: [],
    penHover: null,
    activeAnchor: null,
    textStyle: DEFAULT_TEXT_STYLE,
    editingText: null,
    toast: null,

    addNodes(nodes, parentId) {
      // Nodes inside an added group stay there: the group's childIds already place them.
      const batch = new Set(nodes.map((node) => node.id))
      const { currentPageId } = get()
      commit((doc) => {
        let order = rootsOf(doc, currentPageId)
        if (parentId !== undefined) {
          const parent = doc.nodes[parentId]
          if (parent?.type !== 'group') return
          order = parent.childIds
        }
        const parentKey = parentId ?? null
        for (const node of nodes) {
          if (node.id in doc.nodes) continue
          if (node.parentId !== null && batch.has(node.parentId)) {
            doc.nodes[node.id] = node
            continue
          }
          doc.nodes[node.id] = node.parentId === parentKey ? node : { ...node, parentId: parentKey }
          order.push(node.id)
        }
      })
    },

    replaceDoc(next) {
      // An edit still open ends first, as its own step.
      get().endGesture()
      const state = get()
      const { doc, past, currentPageId } = state
      if (next === doc) return
      // The same page stays when the new doc has it, keeping its view; otherwise its first page.
      const pageId = pageById(next, currentPageId) ? currentPageId : next.pages[0].id
      set({
        doc: next,
        past: pushSnapshot(past, doc),
        future: [],
        ...showPage(state, next, pageId),
        views: {},
        selection: [],
        activeAnchor: null,
        editingText: null,
        erasing: [],
        marquee: null,
      })
    },

    updateNodes(patch, mergeKey) {
      const recipe = (doc: Draft<Doc>) => {
        for (const [id, changes] of Object.entries(patch)) {
          const node = doc.nodes[id]
          if (node) Object.assign(node, changes)
        }
      }
      if (mergeKey === undefined) commit(recipe)
      else commitMerging(mergeKey, recipe)
    },

    deleteNodes(ids) {
      commit((doc) => {
        // Deleting a group deletes everything inside it.
        const doomed = new Set<NodeId>()
        const collect = (id: NodeId) => {
          const node = doc.nodes[id]
          if (!node || doomed.has(id)) return
          doomed.add(id)
          if (node.type === 'group') node.childIds.forEach(collect)
        }
        ids.forEach(collect)
        if (doomed.size === 0) return

        const keep = (id: NodeId) => !doomed.has(id)
        const parents = new Set<NodeId>()
        for (const page of doc.pages) {
          if (!page.rootIds.every(keep)) page.rootIds = page.rootIds.filter(keep)
        }
        for (const node of Object.values(doc.nodes)) {
          if (node.type === 'group' && !doomed.has(node.id) && !node.childIds.every(keep)) {
            node.childIds = node.childIds.filter(keep)
            parents.add(node.id)
          }
        }
        for (const id of doomed) delete doc.nodes[id]
        // A group never stays empty.
        dropEmptyGroups(doc, parents)
      })
    },

    splitStrokes(cuts) {
      const { doc } = get()
      commit((draft) => {
        const parents = new Set<NodeId | null>()
        for (const [id, runs] of Object.entries(cuts)) {
          const stroke = doc.nodes[id]
          const node = draft.nodes[id]
          if (stroke?.type !== 'stroke' || node?.type !== 'stroke') continue
          if (runs.length === 0) {
            detach(draft, id)
            delete draft.nodes[id]
            parents.add(stroke.parentId)
            continue
          }
          // The first run keeps the stroke; the others are copies just above it, in their order
          // along the stroke.
          node.points = runs[0]
          const copies = runs.slice(1).map((points) => ({ ...stroke, id: newNodeId(), points }))
          for (const copy of copies) draft.nodes[copy.id] = copy
          const siblings = siblingsOf(draft, id)
          siblings.splice(siblings.indexOf(id) + 1, 0, ...copies.map((copy) => copy.id))
        }
        // A group never stays empty.
        dropEmptyGroups(draft, parents)
      })
    },

    reorder(ids, where) {
      const picked = new Set(ids)
      if (picked.size === 0) return
      commit((doc) => {
        for (const page of doc.pages) {
          const next = reorderIds(page.rootIds, picked, where)
          if (!sameOrder(next, page.rootIds)) page.rootIds = next
        }
        for (const node of Object.values(doc.nodes)) {
          if (node.type !== 'group') continue
          const children = reorderIds(node.childIds, picked, where)
          if (!sameOrder(children, node.childIds)) node.childIds = children
        }
      })
    },

    group(ids) {
      const { doc } = get()
      const picked = outermost(doc, ids)
      if (picked.length === 0) return
      // The group takes the place of the front-most node, in that node's parent.
      const front = picked[picked.length - 1]
      const parentId = doc.nodes[front].parentId
      const frame = parentId === null ? IDENTITY_TRANSFORM : absoluteTransform(doc.nodes, parentId)
      // Nodes from other groups keep where they are on the canvas.
      const transforms = picked.map((id) =>
        doc.nodes[id].parentId === parentId
          ? doc.nodes[id].transform
          : relativeTransform(frame, absoluteTransform(doc.nodes, id)),
      )
      const formerParents = picked.map((id) => doc.nodes[id].parentId)
      const group = createGroupNode(picked, parentId)
      commit((draft) => {
        const siblings = siblingsOf(draft, front)
        siblings.splice(siblings.indexOf(front) + 1, 0, group.id)
        picked.forEach((id, i) => {
          detach(draft, id)
          const node = draft.nodes[id]
          node.parentId = group.id
          node.transform = transforms[i]
        })
        draft.nodes[group.id] = group
        dropEmptyGroups(draft, formerParents)
      })
      set({ selection: [group.id], activeAnchor: null })
    },

    ungroup(id) {
      const { doc } = get()
      const group = doc.nodes[id]
      if (group?.type !== 'group') return
      const children = group.childIds.filter((child) => child in doc.nodes)
      const { opacity } = group.style
      commit((draft) => {
        const siblings = siblingsOf(draft, id)
        siblings.splice(siblings.indexOf(id), 1, ...children)
        // The group's transform, opacity, visibility and lock pass to its children.
        for (const child of children) {
          const node = draft.nodes[child]
          node.parentId = group.parentId
          if (!isIdentity(group.transform)) {
            node.transform = composeTransform(group.transform, node.transform)
          }
          if (opacity !== 1) node.style = { ...node.style, opacity: node.style.opacity * opacity }
          if (group.hidden) node.hidden = true
          if (group.locked) node.locked = true
        }
        delete draft.nodes[id]
      })
      // Ungrouping one of several selected groups keeps the others selected.
      const { selection, doc: next, currentPageId } = get()
      const rest = selection.filter((s) => s !== id)
      set({ selection: pickable([...rest, ...children], next, currentPageId) })
    },

    moveNodes(ids, parentId, index) {
      const { doc, currentPageId } = get()
      if (parentId !== null && doc.nodes[parentId]?.type !== 'group') return
      // A group can't go inside itself.
      const moving = outermost(doc, ids).filter(
        (id) => parentId === null || !isWithin(doc, parentId, id),
      )
      if (moving.length === 0) return
      const frame = parentId === null ? IDENTITY_TRANSFORM : absoluteTransform(doc.nodes, parentId)
      const target =
        parentId === null
          ? (pageById(doc, currentPageId)?.rootIds ?? [])
          : (doc.nodes[parentId] as GroupNode).childIds
      const rest = target.filter((id) => !moving.includes(id))
      const at = Math.max(0, Math.min(rest.length, Math.round(index)))
      const order = [...rest.slice(0, at), ...moving, ...rest.slice(at)]
      const inPlace = moving.every((id) => doc.nodes[id].parentId === parentId)
      if (inPlace && sameOrder(order, target)) return

      const moves = moving.map((id) => {
        const node = doc.nodes[id]
        const transform =
          node.parentId === parentId
            ? node.transform
            : relativeTransform(frame, absoluteTransform(doc.nodes, id))
        return { id, from: node.parentId, transform }
      })
      commit((draft) => {
        for (const { id } of moves) detach(draft, id)
        if (parentId !== null) (draft.nodes[parentId] as Draft<GroupNode>).childIds = order
        else {
          const page = draft.pages.find((p) => p.id === currentPageId)
          if (page) page.rootIds = order
        }
        for (const { id, transform } of moves) {
          const node = draft.nodes[id]
          node.parentId = parentId
          node.transform = transform
        }
        dropEmptyGroups(
          draft,
          moves.map((m) => m.from),
        )
      })
    },

    nudge(ids, dx, dy) {
      if (dx === 0 && dy === 0) return
      const { doc } = get()
      // On screen: a node in a turned group moves the way the arrow points.
      const moves = outermost(doc, ids).map(
        (id) => [id, deltaInParent(doc.nodes, id, dx, dy)] as const,
      )
      commitMerging('nudge', (draft) => {
        for (const [id, [x, y]] of moves) {
          const node = draft.nodes[id]
          if (!node || node.locked) continue
          node.transform = { ...node.transform, x: node.transform.x + x, y: node.transform.y + y }
        }
      })
    },

    duplicate(ids) {
      const { doc } = get()
      insertCopies(collectSubtrees(doc, outermost(doc, ids)), PASTE_OFFSET)
    },

    copy(ids) {
      const { doc } = get()
      const roots = new Set(outermost(doc, ids))
      // Copied nodes leave their groups, keeping where they are on the canvas.
      const nodes = collectSubtrees(doc, [...roots]).map((node) =>
        roots.has(node.id) && node.parentId !== null
          ? { ...node, parentId: null, transform: absoluteTransform(doc.nodes, node.id) }
          : node,
      )
      if (nodes.length === 0) return
      pasteCount = 0
      set({ clipboard: nodes })
    },

    paste() {
      const { clipboard } = get()
      if (clipboard.length === 0) return
      pasteCount += 1
      insertCopies(clipboard, PASTE_OFFSET * pasteCount)
    },

    convertToPath(ids) {
      const { doc } = get()
      const paths = ids.flatMap((id) => {
        const node = doc.nodes[id]
        return node && !node.locked && canConvertToPath(node) ? [shapeToPath(node)] : []
      })
      if (paths.length === 0) return
      commit((draft) => {
        for (const path of paths) draft.nodes[path.id] = path
      })
    },

    beginGesture() {
      const { gestureStart, doc } = get()
      if (gestureStart) return
      set({ gestureStart: doc })
    },

    endGesture() {
      const { gestureStart, doc, past } = get()
      if (!gestureStart) return
      if (doc === gestureStart) set({ gestureStart: null })
      else set({ gestureStart: null, past: pushSnapshot(past, gestureStart), future: [] })
    },

    cancelGesture() {
      const { gestureStart, doc } = get()
      if (!gestureStart) return
      set({ doc: gestureStart, gestureStart: null, ...settle(doc, gestureStart) })
    },

    // An undo or redo of a change made on another page shows that page.
    undo() {
      const { past, doc, future, gestureStart } = get()
      const previous = past.at(-1)
      if (!previous || gestureStart) return
      set({
        doc: previous,
        past: past.slice(0, -1),
        future: [...future, doc],
        ...settle(doc, previous, { follow: true }),
      })
    },

    redo() {
      const { past, doc, future, gestureStart } = get()
      const next = future.at(-1)
      if (!next || gestureStart) return
      set({
        doc: next,
        past: pushSnapshot(past, doc),
        future: future.slice(0, -1),
        ...settle(doc, next, { follow: true }),
      })
    },

    // Clears the current page only.
    clear() {
      const { doc, currentPageId } = get()
      const page = pageById(doc, currentPageId)
      if (!page || page.rootIds.length === 0) return
      const doomed = collectSubtrees(doc, page.rootIds).map((node) => node.id)
      commit((draft) => {
        for (const id of doomed) delete draft.nodes[id]
        const target = draft.pages.find((p) => p.id === currentPageId)
        if (target) target.rootIds = []
      })
      set({ selection: [] })
    },

    select(ids, mode = 'replace') {
      const { doc, selection, activeAnchor, currentPageId } = get()
      // Hidden and locked nodes, anything in a hidden or locked group, and anything on another
      // page can't be selected.
      const picked = [...new Set(ids)].filter((id) => isPickable(doc, id, currentPageId))
      let next: NodeId[]
      if (mode === 'replace') next = picked
      else if (mode === 'add') next = [...new Set([...selection, ...picked])]
      else {
        const toggled = new Set(selection)
        for (const id of picked) {
          if (toggled.has(id)) toggled.delete(id)
          else toggled.add(id)
        }
        next = [...toggled]
      }
      // An anchor stays active only while its path is selected.
      const keepAnchor = activeAnchor !== null && next.includes(activeAnchor.id)
      set({ selection: next, activeAnchor: keepAnchor ? activeAnchor : null })
    },

    setTool(t) {
      set({ tool: t })
    },

    setBrush(brush) {
      const current = get().brush
      set({ brush: { ...current, ...brush, size: clampSize(brush.size ?? current.size) } })
    },

    setEraserMode(mode) {
      set({ eraserMode: mode })
    },

    setShapeStyle(style) {
      const current = get().shapeStyle
      set({
        shapeStyle: {
          ...current,
          ...style,
          strokeWidth: clampSize(style.strokeWidth ?? current.strokeWidth),
          opacity: clampOpacity(style.opacity ?? current.opacity),
        },
      })
    },

    setDraft(node) {
      set({ draft: node })
    },

    setErasing(ids) {
      set({ erasing: ids })
    },

    setMarquee(rect) {
      set({ marquee: rect })
    },

    setPenHover(point) {
      set({ penHover: point })
    },

    setActiveAnchor(anchor) {
      set({ activeAnchor: anchor })
    },

    setTextStyle(style) {
      const current = get().textStyle
      const fontSize = style.fontSize ?? current.fontSize
      set({
        textStyle: {
          ...current,
          ...style,
          fontSize: Number.isFinite(fontSize)
            ? Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, Math.round(fontSize)))
            : current.fontSize,
        },
      })
    },

    setEditingText(id) {
      set({ editingText: id })
    },

    showToast(message) {
      toastCount += 1
      set({ toast: { id: toastCount, message } })
    },

    dismissToast(id) {
      if (get().toast?.id === id) set({ toast: null })
    },

    setCurrentPage(id) {
      // An edit still open ends first, on the page it began on.
      get().endGesture()
      const state = get()
      if (id === state.currentPageId || !pageById(state.doc, id)) return
      set({ ...showPage(state, state.doc, id), marquee: null, erasing: [], penHover: null })
    },

    addPage() {
      const { doc } = get()
      const current = currentPageOf(get())
      // The same size as the page it follows, as slides in a deck are.
      const page = newPage(newNodeId(), nextPageName(doc.pages), current.width, current.height)
      const index = doc.pages.indexOf(current) + 1
      commit((draft) => void draft.pages.splice(index, 0, page), { switchTo: page.id })
    },

    duplicatePage(id) {
      const { doc } = get()
      const page = pageById(doc, id)
      if (!page) return
      // Copies keep their places: roots go to the top level of the new page, unmoved.
      const copies = withNewIds(doc, collectSubtrees(doc, page.rootIds), 0)
      const copy: Page = {
        ...page,
        id: newNodeId(),
        name: `${page.name} copy`,
        rootIds: copies.roots,
      }
      const index = doc.pages.indexOf(page) + 1
      commit(
        (draft) => {
          for (const node of copies.nodes) draft.nodes[node.id] = node
          draft.pages.splice(index, 0, copy)
        },
        { switchTo: copy.id },
      )
    },

    deletePage(id) {
      const { doc } = get()
      const page = pageById(doc, id)
      // A document always has a page.
      if (!page || doc.pages.length === 1) return
      const doomed = collectSubtrees(doc, page.rootIds).map((node) => node.id)
      commit((draft) => {
        for (const nodeId of doomed) delete draft.nodes[nodeId]
        draft.pages.splice(
          draft.pages.findIndex((p) => p.id === id),
          1,
        )
      })
      // A deleted page's view isn't needed again; undo fits it.
      const views = { ...get().views }
      delete views[id]
      set({ views })
    },

    movePage(id, index) {
      const { doc } = get()
      const from = doc.pages.findIndex((page) => page.id === id)
      if (from < 0) return
      // Counted without the moved page.
      const to = Math.max(0, Math.min(doc.pages.length - 1, Math.round(index)))
      if (to === from) return
      commit((draft) => {
        const [page] = draft.pages.splice(from, 1)
        draft.pages.splice(to, 0, page)
      })
    },

    resizePage(id, width, height, scale = false) {
      const { doc } = get()
      const page = pageById(doc, id)
      if (!page) return
      const w = clampPageSize(width)
      const h = clampPageSize(height)
      if (w === page.width && h === page.height) return
      // Scaled to fit the new size whole, and centered on it; otherwise anchored top-left.
      const s = Math.min(w / page.width, h / page.height)
      const patch = scale
        ? scaleContent(
            doc.nodes,
            page.rootIds,
            s,
            (w - page.width * s) / 2,
            (h - page.height * s) / 2,
          )
        : {}
      commit((draft) => {
        const target = draft.pages.find((p) => p.id === id)!
        target.width = w
        target.height = h
        for (const [nodeId, changes] of Object.entries(patch)) {
          const node = draft.nodes[nodeId]
          if (node) Object.assign(node, changes)
        }
      })
    },

    updatePage(id, changes, mergeKey) {
      const recipe = (draft: Draft<Doc>) => {
        const page = draft.pages.find((p) => p.id === id)
        if (!page) return
        const name = changes.name?.trim()
        if (name && name !== page.name) page.name = name
        const { background } = changes
        if (background && !samePaint(background, page.background)) page.background = background
      }
      if (mergeKey === undefined) commit(recipe)
      else commitMerging(mergeKey, recipe)
    },

    moveToPage(ids, pageId, copy) {
      const { doc, currentPageId, showToast } = get()
      const target = pageById(doc, pageId)
      if (!target || pageId === currentPageId) return
      const roots = outermost(doc, ids).filter((id) => pageOf(doc, id) === currentPageId)
      if (roots.length === 0) return
      const picked = new Set(roots)
      // As in copy: they leave their groups, keeping where they are on the canvas.
      const nodes = collectSubtrees(doc, roots).map((node) =>
        picked.has(node.id) && node.parentId !== null
          ? { ...node, parentId: null, transform: absoluteTransform(doc.nodes, node.id) }
          : node,
      )
      if (copy) {
        const copies = withNewIds(doc, nodes, 0)
        commit((draft) => {
          for (const node of copies.nodes) draft.nodes[node.id] = node
          rootsOf(draft, pageId).push(...copies.roots)
        })
      } else {
        const formerParents = roots.map((id) => doc.nodes[id].parentId)
        commit((draft) => {
          for (const id of roots) detach(draft, id)
          for (const node of nodes) if (picked.has(node.id)) draft.nodes[node.id] = node
          rootsOf(draft, pageId).push(...roots)
          // A group never stays empty.
          dropEmptyGroups(draft, formerParents)
        })
      }
      const count = `${roots.length} ${roots.length === 1 ? 'object' : 'objects'}`
      showToast(`${copy ? 'Copied' : 'Moved'} ${count} to ${target.name}.`)
    },

    setViewport(size) {
      const state = get()
      const { viewport, view } = state
      const next = { ...size, fit: fitFor(size, currentPageOf(state)) }
      if (
        next.width === viewport.width &&
        next.height === viewport.height &&
        next.boxWidth === viewport.boxWidth &&
        next.boxHeight === viewport.boxHeight &&
        next.fit === viewport.fit
      )
        return
      if (next.fit <= 0) set({ viewport: next })
      else if (viewport.fit <= 0) {
        set({ viewport: next, view: fittedView(next, currentPageOf(state)) })
      } else {
        // The canvas point in the middle stays in the middle, and the zoom stays relative to the fit.
        const before = zoomOf({ view, viewport })
        const after = next.fit * view.scale
        const cx = (viewport.width / 2 - view.x) / before
        const cy = (viewport.height / 2 - view.y) / before
        set({
          viewport: next,
          view: {
            scale: view.scale,
            x: next.width / 2 - cx * after,
            y: next.height / 2 - cy * after,
          },
        })
      }
    },

    setView(view) {
      set({ view })
    },

    zoomTo(zoom, anchor) {
      const state = get()
      const { view, viewport } = state
      if (viewport.fit <= 0 || !Number.isFinite(zoom)) return
      // The canvas point under the anchor stays under it; by default that is the middle.
      const [ax, ay] = anchor ?? [viewport.width / 2, viewport.height / 2]
      const after = clampZoom(zoom)
      const ratio = after / zoomOf(state)
      set({
        view: {
          scale: after / viewport.fit,
          x: ax - (ax - view.x) * ratio,
          y: ay - (ay - view.y) * ratio,
        },
      })
    },

    panBy(dx, dy) {
      const { view } = get()
      if (dx === 0 && dy === 0) return
      set({ view: { ...view, x: view.x + dx, y: view.y + dy } })
    },

    fitView() {
      const state = get()
      if (state.viewport.fit > 0) set({ view: fittedView(state.viewport, currentPageOf(state)) })
    },
  }
})
