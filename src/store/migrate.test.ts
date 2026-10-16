import { describe, expect, it, vi } from 'vitest'
import {
  STORAGE_KEY,
  V2_STORAGE_KEY,
  loadStartupDoc,
  sanitizeDoc,
  type KeyValueStore,
} from '../lib/persistence'
import { solid } from '../lib/paint/paint'
import { IDENTITY_TRANSFORM, emptyDoc, type Doc, type Point, type StrokeNode } from '../types'
import { V1_STORAGE_KEY, loadV1Strokes, migrateV1, migrateV2, type V1Stroke } from './migrate'

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

const roots = (doc: Doc) => doc.pages[0].rootIds
const strokes = (doc: Doc) => roots(doc).map((id) => doc.nodes[id] as StrokeNode)

/** A v2 drawing as v2 saved it: a stroke, a filled rectangle, an open path and a group. */
function v2Drawing() {
  const base = {
    parentId: null,
    transform: IDENTITY_TRANSFORM,
    hidden: false,
    locked: false,
  }
  const corner = (x: number, y: number) => ({
    x,
    y,
    inX: 0,
    inY: 0,
    outX: 0,
    outY: 0,
    kind: 'corner',
  })
  return {
    version: 2,
    width: 1600,
    height: 1000,
    background: '#fef3c7',
    rootIds: ['s', 'r', 'g'],
    nodes: {
      s: {
        ...base,
        id: 's',
        type: 'stroke',
        name: 'Stroke',
        style: { fill: solid('#ef4444'), stroke: null, strokeWidth: 0, opacity: 1 },
        points: [
          [0, 0, 0.5],
          [10, 10, 0.5],
        ],
        size: 8,
        usesPressure: false,
      },
      r: {
        ...base,
        id: 'r',
        type: 'rect',
        name: 'Rectangle',
        style: { fill: '#3b82f6', stroke: '#000000', strokeWidth: 4, opacity: 1 },
        width: 100,
        height: 50,
        cornerRadius: 0,
      },
      g: {
        ...base,
        id: 'g',
        type: 'group',
        name: 'Group',
        style: { fill: null, stroke: null, strokeWidth: 0, opacity: 1 },
        childIds: ['p'],
      },
      p: {
        ...base,
        id: 'p',
        parentId: 'g',
        type: 'path',
        name: 'Path',
        style: { fill: null, stroke: '#000000', strokeWidth: 4, opacity: 1 },
        anchors: [corner(0, 0), corner(100, 0)],
        closed: false,
      },
    },
  }
}

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

    expect(roots(doc)).toEqual(['a', 'b'])
    expect(doc.nodes.a).toEqual({
      id: 'a',
      type: 'stroke',
      name: 'Stroke',
      parentId: null,
      transform: IDENTITY_TRANSFORM,
      style: { fill: solid('#ef4444'), stroke: null, strokeWidth: 0, opacity: 1 },
      hidden: false,
      locked: false,
      points: a.points,
      size: 12,
      usesPressure: true,
    })
    expect(strokes(doc)[1].style.fill).toEqual(solid('#3b82f6'))
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

    expect(roots(doc)).toHaveLength(4)
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

    expect(roots(doc)).toEqual(['d'])
    expect((doc.nodes.d as StrokeNode).points).toEqual([[300, 300, 0.5]])
  })

  it('applies several erasers in order', () => {
    const second = v1Eraser('e2')
    second.points = second.points.map(([, y, p]): Point => [80, y, p])

    const doc = migrateV1([v1Stroke('a'), v1Eraser('e1'), second])

    expect(roots(doc)).toHaveLength(3)
  })
})

describe('migrateV2', () => {
  it('turns the artboard into page 1, fills into solid paints and anchors into one contour', () => {
    const v2 = v2Drawing()
    const doc = sanitizeDoc(migrateV2(v2))

    expect(doc.version).toBe(3)
    expect(doc.pages).toEqual([
      {
        id: 'page-1',
        name: 'Page 1',
        width: 1600,
        height: 1000,
        background: solid('#fef3c7'),
        rootIds: ['s', 'r', 'g'],
      },
    ])
    expect(doc.nodes.s.style.fill).toEqual(solid('#ef4444'))
    expect(doc.nodes.r.style).toEqual({
      fill: solid('#3b82f6'),
      stroke: '#000000',
      strokeWidth: 4,
      opacity: 1,
    })
    expect(doc.nodes.p).toMatchObject({
      parentId: 'g',
      contours: [{ anchors: v2.nodes.p.anchors, closed: false }],
      fillRule: 'nonzero',
    })
    expect(doc.nodes.p).not.toHaveProperty('anchors')
    expect(doc.nodes.g).toMatchObject({ childIds: ['p'] })
    expect(doc.assets).toEqual({})
  })

  it('leaves anything that is not a v2 doc for sanitizeDoc to refuse', () => {
    const v3 = emptyDoc()
    expect(migrateV2(v3)).toBe(v3)
    expect(migrateV2('garbage')).toBe('garbage')
    expect(sanitizeDoc(migrateV2({ version: 2, nodes: {}, rootIds: 'x' }))).toEqual(emptyDoc())
  })
})

describe('loadStartupDoc', () => {
  it('opens the v3 autosave when there is one', async () => {
    const kv = memoryStore()
    const storage = memoryStorage()
    kv.data.set(STORAGE_KEY, migrateV1([v1Stroke('saved')]))
    kv.data.set(V2_STORAGE_KEY, v2Drawing())
    storage.setItem(V1_STORAGE_KEY, JSON.stringify([v1Stroke('old')]))

    expect(roots(await loadStartupDoc(kv, storage))).toEqual(['saved'])
  })

  it('migrates the v2 autosave once, saves it as v3 and keeps the v2 key', async () => {
    const kv = memoryStore()
    const storage = memoryStorage()
    kv.data.set(V2_STORAGE_KEY, v2Drawing())
    storage.setItem(V1_STORAGE_KEY, JSON.stringify([v1Stroke('old')]))

    const doc = await loadStartupDoc(kv, storage)

    expect(roots(doc)).toEqual(['s', 'r', 'g'])
    expect(kv.data.get(STORAGE_KEY)).toEqual(doc)
    expect(kv.data.get(V2_STORAGE_KEY)).toEqual(v2Drawing())
    expect(await loadStartupDoc(kv, storage)).toEqual(doc)
  })

  it('migrates v1 once, saves it as v3 and keeps the v1 key', async () => {
    const kv = memoryStore()
    const storage = memoryStorage()
    const v1 = JSON.stringify([v1Stroke('a'), v1Eraser('e')])
    storage.setItem(V1_STORAGE_KEY, v1)

    const doc = await loadStartupDoc(kv, storage)

    expect(roots(doc)).toHaveLength(2)
    expect(roots(kv.data.get(STORAGE_KEY) as Doc)).toEqual(roots(doc))
    expect(storage.getItem(V1_STORAGE_KEY)).toBe(v1)

    // The next start reads the saved v3 doc, with the same ids.
    expect(roots(await loadStartupDoc(kv, storage))).toEqual(roots(doc))
  })

  it('opens an empty doc without saving when there is nothing to migrate', async () => {
    const kv = memoryStore()

    expect(await loadStartupDoc(kv, memoryStorage())).toEqual(emptyDoc())
    expect(kv.data.size).toBe(0)
  })

  it('opens unreadable v3 data as an empty doc instead of migrating again', async () => {
    const kv = memoryStore()
    const storage = memoryStorage()
    kv.data.set(STORAGE_KEY, 'garbage')
    kv.data.set(V2_STORAGE_KEY, v2Drawing())
    storage.setItem(V1_STORAGE_KEY, JSON.stringify([v1Stroke('old')]))

    expect(await loadStartupDoc(kv, storage)).toEqual(emptyDoc())
  })

  it('opens an empty doc and saves nothing when storage can not be read', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const kv = memoryStore()
    kv.data.set(V2_STORAGE_KEY, v2Drawing())
    const { set } = kv
    kv.get = () => Promise.reject(new DOMException('Blocked', 'SecurityError'))
    kv.set = vi.fn(set)

    expect(await loadStartupDoc(kv, memoryStorage())).toEqual(emptyDoc())
    expect(kv.set).not.toHaveBeenCalled()
    vi.restoreAllMocks()
  })
})
