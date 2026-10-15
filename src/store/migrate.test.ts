import { describe, expect, it } from 'vitest'
import { STORAGE_KEY, type KeyValueStore } from '../lib/persistence'
import { IDENTITY_TRANSFORM, emptyDoc, type Point, type StrokeNode } from '../types'
import { V1_STORAGE_KEY, loadStartupDoc, loadV1Strokes, migrateV1, type V1Stroke } from './migrate'

function memoryStorage(): Storage {
  const data = new Map<string, string>()
  return {
    get length() {
      return data.size
    },
    clear: () => data.clear(),
    getItem: (key) => data.get(key) ?? null,
    key: (index) => [...data.keys()][index] ?? null,
    removeItem: (key) => {
      data.delete(key)
    },
    setItem: (key, value) => {
      data.set(key, String(value))
    },
  }
}

function memoryStore(): KeyValueStore & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>()
  return {
    data,
    get: async (key) => structuredClone(data.get(key)),
    set: async (key, value) => {
      data.set(key, structuredClone(value))
    },
  }
}

/** A horizontal v1 stroke along y with a point every 10 units. */
function v1Stroke(id: string, overrides: Partial<V1Stroke> = {}, y = 0): V1Stroke {
  const points: Point[] = []
  for (let x = 0; x <= 100; x += 10) points.push([x, y, 0.5])
  return { id, tool: 'brush', color: '#ef4444', size: 8, usesPressure: false, points, ...overrides }
}

/** A vertical v1 eraser stroke at x = 50, crossing y = -50 to 50. */
const v1Eraser = (id: string): V1Stroke =>
  v1Stroke(id, {
    tool: 'eraser',
    size: 20,
    points: [
      [50, -50, 0.5],
      [50, 50, 0.5],
    ],
  })

const strokes = (doc: ReturnType<typeof migrateV1>) =>
  doc.rootIds.map((id) => doc.nodes[id] as StrokeNode)

describe('loadV1Strokes', () => {
  it('reads valid strokes and skips malformed ones', () => {
    const storage = memoryStorage()
    const valid = v1Stroke('a')
    storage.setItem(
      V1_STORAGE_KEY,
      JSON.stringify([
        valid,
        { id: 'x' },
        v1Stroke('b', { points: [] }),
        { ...valid, tool: 'pencil' },
      ]),
    )

    expect(loadV1Strokes(storage)).toEqual([valid])
  })

  it('reads nothing from missing or corrupt data', () => {
    const storage = memoryStorage()
    expect(loadV1Strokes(storage)).toEqual([])
    expect(loadV1Strokes(null)).toEqual([])

    storage.setItem(V1_STORAGE_KEY, '{not json')
    expect(loadV1Strokes(storage)).toEqual([])
  })
})

describe('migrateV1', () => {
  it('turns brush strokes into stroke nodes in the same order', () => {
    const a = v1Stroke('a', { usesPressure: true, size: 12 })
    const b = v1Stroke('b', { color: '#3b82f6' }, 40)

    const doc = migrateV1([a, b])

    expect(doc.rootIds).toEqual(['a', 'b'])
    expect(doc.nodes.a).toEqual({
      id: 'a',
      type: 'stroke',
      name: 'Stroke',
      parentId: null,
      transform: IDENTITY_TRANSFORM,
      style: { fill: '#ef4444', stroke: null, strokeWidth: 0, opacity: 1 },
      hidden: false,
      locked: false,
      points: a.points,
      size: 12,
      usesPressure: true,
    })
    expect(strokes(doc)[1].style.fill).toBe('#3b82f6')
  })

  it('migrates no strokes to an empty doc', () => {
    expect(migrateV1([])).toEqual(emptyDoc())
  })

  it('splits strokes drawn before an eraser and keeps their place in the z-order', () => {
    const doc = migrateV1([
      v1Stroke('a'),
      v1Stroke('b', {}, 200),
      v1Eraser('e'),
      v1Stroke('c', {}, 0),
    ])
    const [left, right, untouched, after] = strokes(doc)

    expect(doc.rootIds).toHaveLength(4)
    expect(left.points.at(-1)![0]).toBeLessThan(50)
    expect(right.points[0][0]).toBeGreaterThan(50)
    expect(left.id).not.toBe('a')
    expect(left.id).not.toBe(right.id)
    // Split pieces keep the original's color, size and the rest.
    const original = migrateV1([v1Stroke('a')]).nodes.a
    expect({ ...left, id: '', points: [] }).toEqual({ ...original, id: '', points: [] })
    expect(untouched.id).toBe('b')
    // The eraser only cut what was drawn before it.
    expect(after.id).toBe('c')
    expect(after.points).toHaveLength(11)
  })

  it('removes strokes an eraser covers completely, and keeps dots it misses', () => {
    const covered = v1Stroke('a', {
      points: [
        [50, 0, 0.5],
        [50, 10, 0.5],
      ],
    })
    const dot = v1Stroke('d', { points: [[300, 300, 0.5]] })

    const doc = migrateV1([covered, dot, v1Eraser('e')])

    expect(doc.rootIds).toEqual(['d'])
    expect((doc.nodes.d as StrokeNode).points).toEqual([[300, 300, 0.5]])
  })

  it('applies several erasers in order', () => {
    const second = v1Eraser('e2')
    second.points = second.points.map(([, y, p]): Point => [80, y, p])

    const doc = migrateV1([v1Stroke('a'), v1Eraser('e1'), second])

    expect(doc.rootIds).toHaveLength(3)
  })
})

describe('loadStartupDoc', () => {
  it('opens the v2 autosave when there is one', async () => {
    const kv = memoryStore()
    const storage = memoryStorage()
    const saved = migrateV1([v1Stroke('saved')])
    kv.data.set(STORAGE_KEY, saved)
    storage.setItem(V1_STORAGE_KEY, JSON.stringify([v1Stroke('old')]))

    expect((await loadStartupDoc(kv, storage)).rootIds).toEqual(['saved'])
  })

  it('migrates v1 once, saves it as v2 and keeps the v1 key', async () => {
    const kv = memoryStore()
    const storage = memoryStorage()
    const v1 = JSON.stringify([v1Stroke('a'), v1Eraser('e')])
    storage.setItem(V1_STORAGE_KEY, v1)

    const doc = await loadStartupDoc(kv, storage)

    expect(doc.rootIds).toHaveLength(2)
    expect((kv.data.get(STORAGE_KEY) as typeof doc).rootIds).toEqual(doc.rootIds)
    expect(storage.getItem(V1_STORAGE_KEY)).toBe(v1)

    // The next start reads the saved v2 doc, with the same ids.
    expect((await loadStartupDoc(kv, storage)).rootIds).toEqual(doc.rootIds)
  })

  it('opens an empty doc without saving when there is nothing to migrate', async () => {
    const kv = memoryStore()

    expect(await loadStartupDoc(kv, memoryStorage())).toEqual(emptyDoc())
    expect(kv.data.size).toBe(0)
  })

  it('opens unreadable v2 data as an empty doc instead of migrating again', async () => {
    const kv = memoryStore()
    const storage = memoryStorage()
    kv.data.set(STORAGE_KEY, 'garbage')
    storage.setItem(V1_STORAGE_KEY, JSON.stringify([v1Stroke('old')]))

    expect(await loadStartupDoc(kv, storage)).toEqual(emptyDoc())
  })
})
