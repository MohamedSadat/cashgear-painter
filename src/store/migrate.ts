import { eraseSplit } from '../lib/geometry/eraseSplit'
import { defaultKeyValueStore, loadDoc, saveDoc, type KeyValueStore } from '../lib/persistence'
import { emptyDoc, type Doc, type Point, type StrokeNode } from '../types'
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

function defaultStorage(): Storage | null {
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
 * Turns v1 strokes into a v2 doc. Brush strokes become stroke nodes. v1 erased with
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
    doc.rootIds.push(id)
  }
  return doc
}

/**
 * The doc to open on start: the v2 autosave when there is one, otherwise the v1 drawing migrated
 * once. The v1 key stays as a backup. Unreadable v2 data opens as an empty doc, without migrating.
 */
export async function loadStartupDoc(
  kv: KeyValueStore | null = defaultKeyValueStore(),
  storage: Storage | null = defaultStorage(),
): Promise<Doc> {
  const saved = await loadDoc(kv)
  if (saved) return saved
  const strokes = loadV1Strokes(storage)
  const doc = migrateV1(strokes)
  if (strokes.length > 0) await saveDoc(doc, kv)
  return doc
}
