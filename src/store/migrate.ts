import { eraseSplit } from '../lib/geometry/eraseSplit'
import {
  DEFAULT_PAGE_HEIGHT,
  DEFAULT_PAGE_WIDTH,
  FIRST_PAGE_ID,
  emptyDoc,
  type Doc,
  type Point,
  type StrokeNode,
} from '../types'
import { createStrokeNode, newNodeId } from './editorStore'

export const V1_STORAGE_KEY = 'painter:v1'

/** A stroke as v1 saved it in localStorage. */
export interface V1Stroke {
  id: string
  tool: 'brush' | 'eraser'
  color: string // hex; ignored for eraser
  size: number // in canvas units
  usesPressure: boolean // true only when drawn with a pen
  points: Point[]
}

export function defaultStorage(): Storage | null {
  // Reading localStorage itself throws when site data is blocked.
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null
  }
}

function isPoint(value: unknown): value is Point {
  return (
    Array.isArray(value) &&
    value.length === 3 &&
    value.every((n) => typeof n === 'number' && Number.isFinite(n))
  )
}

function isV1Stroke(value: unknown): value is V1Stroke {
  if (typeof value !== 'object' || value === null) return false
  const s = value as Record<string, unknown>
  return (
    typeof s.id === 'string' &&
    (s.tool === 'brush' || s.tool === 'eraser') &&
    typeof s.color === 'string' &&
    typeof s.size === 'number' &&
    Number.isFinite(s.size) &&
    typeof s.usesPressure === 'boolean' &&
    Array.isArray(s.points) &&
    s.points.length > 0 &&
    s.points.every(isPoint)
  )
}

/** Strokes saved by v1; anything missing or malformed loads as no strokes. */
export function loadV1Strokes(storage: Storage | null = defaultStorage()): V1Stroke[] {
  try {
    const raw = storage?.getItem(V1_STORAGE_KEY)
    if (!raw) return []
    const data: unknown = JSON.parse(raw)
    return Array.isArray(data) ? data.filter(isV1Stroke) : []
  } catch {
    return []
  }
}

/**
 * Turns v1 strokes into a doc of one page. Brush strokes become stroke nodes. v1 erased with
 * destination-out, which only cut what was drawn before it, so each eraser stroke splits the
 * strokes collected so far and leaves later ones alone.
 */
export function migrateV1(strokes: V1Stroke[]): Doc {
  let kept: StrokeNode[] = []
  for (const stroke of strokes) {
    if (stroke.tool === 'brush') {
      kept.push(createStrokeNode(stroke.points, stroke, stroke.id))
      continue
    }
    kept = kept.flatMap((node) => {
      const runs = eraseSplit(node.points, node.size, stroke)
      if (runs.length === 1 && runs[0] === node.points) return [node]
      return runs.map((points) => ({ ...node, id: newNodeId(), points }))
    })
  }

  const doc = emptyDoc()
  for (const node of kept) {
    const id = node.id in doc.nodes ? newNodeId() : node.id
    doc.nodes[id] = id === node.id ? node : { ...node, id }
    doc.pages[0].rootIds.push(id)
  }
  return doc
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** A v2 node in v3's shape: a fill string becomes a solid paint, a path's anchors one contour. */
function migrateNodeV2(node: unknown): unknown {
  if (!isObject(node)) return node
  let out: Record<string, unknown> = node
  const style = node.style
  if (isObject(style) && typeof style.fill === 'string') {
    out = { ...out, style: { ...style, fill: { kind: 'solid', color: style.fill } } }
  }
  if (node.type === 'path' && !('contours' in node)) {
    const { anchors, closed, ...rest } = out
    out = { ...rest, contours: [{ anchors, closed }], fillRule: 'nonzero' }
  }
  return out
}

/**
 * A v2 doc (autosave or file) in v3's shape, before sanitizeDoc checks it: the artboard becomes
 * "Page 1", 1600 × 1000, with the same background and objects; fills become solid paints and
 * each path's anchors one contour with the nonzero rule. Anything that isn't a v2 doc comes back
 * as it is, for sanitizeDoc to refuse.
 */
export function migrateV2(value: unknown): unknown {
  if (!isObject(value) || value.version !== 2) return value
  const nodes = isObject(value.nodes)
    ? Object.fromEntries(Object.entries(value.nodes).map(([id, node]) => [id, migrateNodeV2(node)]))
    : value.nodes
  const background = typeof value.background === 'string' ? value.background : '#ffffff'
  return {
    version: 3,
    pages: [
      {
        id: FIRST_PAGE_ID,
        name: 'Page 1',
        width: DEFAULT_PAGE_WIDTH,
        height: DEFAULT_PAGE_HEIGHT,
        background: { kind: 'solid', color: background },
        rootIds: value.rootIds,
      },
    ],
    nodes,
    assets: {},
  }
}
