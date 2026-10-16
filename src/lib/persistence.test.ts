import { afterEach, describe, expect, it, vi } from 'vitest'
import { createStore } from 'zustand/vanilla'
import {
  DEFAULT_SHAPE_STYLE,
  DEFAULT_TEXT_STYLE,
  createEllipseNode,
  createGroupNode,
  createLineNode,
  createPathNode,
  createRectNode,
  createStrokeNode,
  createTextNode,
} from '../store/editorStore'
import {
  emptyDoc,
  type Doc,
  type GroupNode,
  type NodeOf,
  type PathNode,
  type Point,
  type StrokeNode,
  type TextNode,
  type VectorNode,
} from '../types'
import {
  SAVE_DELAY_MS,
  STORAGE_KEY,
  loadDoc,
  sanitizeDoc,
  saveDoc,
  startAutosave,
  type KeyValueStore,
} from './persistence'

/** An in-memory stand-in for IndexedDB; values are cloned like structured clone would. */
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

const stroke = (id: string, points: Point[] = [[10.04, 20.06, 0.5]]): StrokeNode =>
  createStrokeNode(points, { color: '#000000', size: 8, usesPressure: false }, id)

/** A rounded, turned rectangle, an ellipse and an arrow, with odd coordinates kept as they are. */
function shapes(): [NodeOf<'rect'>, NodeOf<'ellipse'>, NodeOf<'line'>] {
  const box = { x: 10.123, y: 20.456, width: 300.789, height: 100 }
  const rect = createRectNode(box, { ...DEFAULT_SHAPE_STYLE, fill: '#ef4444' }, 'rect')
  return [
    { ...rect, cornerRadius: 12, transform: { ...rect.transform, rotation: 30 } },
    createEllipseNode(box, { ...DEFAULT_SHAPE_STYLE, opacity: 0.5 }, 'ellipse'),
    { ...createLineNode([0, 0], [55.55, -20], DEFAULT_SHAPE_STYLE, 'line'), arrowEnd: true },
  ]
}

/** A closed path of every anchor kind, with odd coordinates kept as they are. */
function path(id = 'path'): PathNode {
  return createPathNode(
    [
      { x: 10.123, y: 20, inX: 0, inY: 0, outX: 0, outY: 0, kind: 'corner' },
      { x: 110, y: 20.456, inX: -30, inY: -40, outX: 15, outY: 20, kind: 'smooth' },
      { x: 60, y: 90.789, inX: 20, inY: 0, outX: -20, outY: 0, kind: 'symmetric' },
    ],
    true,
    { ...DEFAULT_SHAPE_STYLE, fill: '#3b82f6' },
    id,
  )
}

/** A bold, centered, turned text with odd coordinates kept as they are. */
function text(id = 'text'): TextNode {
  const node = createTextNode(
    10.123,
    20.456,
    300,
    { ...DEFAULT_TEXT_STYLE, fontStyle: 'bold', align: 'center' },
    'Hello\nthere',
    id,
  )
  return { ...node, transform: { ...node.transform, rotation: 15 } }
}

/**
 * A turned group holding a stroke and a group with a text, after a top-level stroke 'a'; the
 * inner group is hidden and the text locked.
 */
function groups(): Doc {
  // Points already rounded, as storage keeps them.
  const doc = docWith(stroke('a', [[10, 20.1, 0.5]]))
  const outer: GroupNode = {
    ...createGroupNode(['s', 'inner'], null, 'outer'),
    transform: { x: 5, y: 6, rotation: 30, scaleX: 1, scaleY: 1 },
  }
  doc.nodes.outer = outer
  doc.nodes.s = { ...stroke('s', [[1.5, 2, 0.25]]), parentId: 'outer' }
  doc.nodes.inner = { ...createGroupNode(['t'], 'outer', 'inner'), hidden: true }
  doc.nodes.t = { ...text('t'), parentId: 'inner', locked: true }
  doc.rootIds.push('outer')
  return doc
}

function docWith(...nodes: VectorNode[]): Doc {
  const doc = emptyDoc()
  for (const node of nodes) {
    doc.nodes[node.id] = node
    doc.rootIds.push(node.id)
  }
  return doc
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('saveDoc and loadDoc', () => {
  it('round-trips the doc, rounding coordinates to 1 decimal and pressure to 2', async () => {
    const kv = memoryStore()

    expect(await saveDoc(docWith(stroke('a', [[10.04, 20.06, 0.123]])), kv)).toBe(true)

    expect(await loadDoc(kv)).toEqual(docWith(stroke('a', [[10, 20.1, 0.12]])))
  })

  it('loads nothing when nothing is saved or there is no storage', async () => {
    expect(await loadDoc(memoryStore())).toBeUndefined()
    expect(await loadDoc(null)).toBeUndefined()
  })

  it('loads nothing when storage can not be read', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const kv = memoryStore()
    kv.get = () => Promise.reject(new DOMException('Blocked', 'SecurityError'))

    expect(await loadDoc(kv)).toBeUndefined()
  })

  it('loads an empty doc from unreadable data', async () => {
    const kv = memoryStore()
    kv.data.set(STORAGE_KEY, '{not a doc')

    expect(await loadDoc(kv)).toEqual(emptyDoc())
  })

  it('reports a failed write instead of throwing', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const kv = memoryStore()
    kv.set = () => Promise.reject(new DOMException('Quota exceeded', 'QuotaExceededError'))

    expect(await saveDoc(docWith(stroke('a')), kv)).toBe(false)
    expect(await saveDoc(docWith(stroke('a')), null)).toBe(false)
  })
})

describe('sanitizeDoc', () => {
  it('rejects other versions and shapes', () => {
    expect(sanitizeDoc(null)).toEqual(emptyDoc())
    expect(sanitizeDoc([])).toEqual(emptyDoc())
    expect(sanitizeDoc({ ...docWith(stroke('a')), version: 3 })).toEqual(emptyDoc())
    expect(sanitizeDoc({ ...docWith(stroke('a')), rootIds: 'a' })).toEqual(emptyDoc())
  })

  it('drops malformed nodes and keeps the valid ones in order', () => {
    const valid = stroke('ok')
    const doc = docWith(
      stroke('a'),
      valid,
      { ...stroke('b'), points: [] },
      { ...stroke('c'), style: { ...valid.style, opacity: Number.NaN } },
    )
    doc.nodes.a = { ...stroke('a'), id: 'other' }
    doc.rootIds.push('missing', 'ok')

    expect(sanitizeDoc(doc)).toEqual(docWith(valid))
  })

  it('drops unknown node types', () => {
    const doc = docWith(stroke('a'))
    doc.nodes.s = { ...stroke('s'), type: 'star' } as unknown as VectorNode
    doc.rootIds.push('s')

    expect(sanitizeDoc(doc).rootIds).toEqual(['a'])
  })

  it('keeps text, and drops malformed or empty text', () => {
    const valid = text()
    const doc = docWith(
      { ...valid, id: 't1', text: '  \n' },
      { ...valid, id: 't2', fontSize: 0 },
      { ...valid, id: 't3', fontStyle: 'heavy' } as unknown as VectorNode,
      { ...valid, id: 't4', align: 'justify' } as unknown as VectorNode,
      { ...valid, id: 't5', width: Number.NaN },
      { ...valid, id: 't6', fontFamily: undefined } as unknown as VectorNode,
      valid,
    )

    expect(sanitizeDoc(doc)).toEqual(docWith(valid))
  })

  it('keeps groups with their children, nested', () => {
    expect(sanitizeDoc(groups())).toEqual(groups())
  })

  it('keeps only children whose parent agrees, once, and drops groups left empty', () => {
    const doc = groups()
    const outer = doc.nodes.outer as GroupNode
    // A child claimed by the wrong group, one listed twice, a missing one, and the group itself.
    doc.nodes.stray = { ...stroke('stray'), parentId: 'elsewhere' }
    doc.nodes.outer = { ...outer, childIds: [...outer.childIds, 'stray', 'a', 'gone', 'outer'] }
    // A group whose only child is malformed, and a node no list reaches.
    doc.nodes.empty = { ...createGroupNode(['bad'], null, 'empty') }
    doc.nodes.bad = { ...stroke('bad'), parentId: 'empty', points: [] }
    doc.nodes.orphan = { ...stroke('orphan'), parentId: 'outer' }
    doc.rootIds.push('empty', 'a')

    expect(sanitizeDoc(doc)).toEqual(groups())
  })

  it('round-trips text and groups through storage unchanged', async () => {
    const kv = memoryStore()
    const doc = groups()

    await saveDoc(doc, kv)

    expect(await loadDoc(kv)).toEqual(doc)
  })

  it('keeps paths', () => {
    const doc = docWith(path(), { ...path('open'), closed: false })

    expect(sanitizeDoc(doc)).toEqual(doc)
  })

  it('drops malformed paths, and paths with fewer than 2 anchors', () => {
    const valid = path()
    const [first, second] = valid.anchors
    const doc = docWith(
      { ...valid, id: 'p1', anchors: [first] },
      {
        ...valid,
        id: 'p2',
        anchors: [first, { ...second, kind: 'curvy' }],
      } as unknown as VectorNode,
      { ...valid, id: 'p3', anchors: [first, { ...second, outY: Number.NaN }] },
      {
        ...valid,
        id: 'p4',
        anchors: [first, { ...second, inX: undefined }],
      } as unknown as VectorNode,
      { ...valid, id: 'p5', closed: 1 } as unknown as VectorNode,
      { ...valid, id: 'p6', anchors: 'M 0 0' } as unknown as VectorNode,
      valid,
    )

    expect(sanitizeDoc(doc).rootIds).toEqual([valid.id])
  })

  it('keeps rectangles, ellipses and lines', () => {
    const doc = docWith(...shapes())

    expect(sanitizeDoc(doc)).toEqual(doc)
  })

  it('drops malformed shapes', () => {
    const [rect, ellipse, line] = shapes()
    const doc = docWith(
      { ...rect, id: 'r1', width: -1 },
      { ...rect, id: 'r2', cornerRadius: Number.NaN },
      { ...ellipse, id: 'e1', ry: '5' } as unknown as VectorNode,
      { ...line, id: 'l1', points: [0, 0, 10] } as unknown as VectorNode,
      { ...line, id: 'l2', arrowEnd: undefined } as unknown as VectorNode,
      rect,
    )

    expect(sanitizeDoc(doc).rootIds).toEqual([rect.id])
  })

  it('round-trips shapes and paths through storage unchanged', async () => {
    const kv = memoryStore()
    const doc = docWith(...shapes(), path())

    await saveDoc(doc, kv)

    expect(await loadDoc(kv)).toEqual(doc)
  })
})

describe('startAutosave', () => {
  it(`saves ${SAVE_DELAY_MS} ms after the doc stops changing`, async () => {
    vi.useFakeTimers()
    const kv = memoryStore()
    const store = createStore<{ doc: Doc }>()(() => ({ doc: emptyDoc() }))
    const stop = startAutosave(store, kv)

    store.setState({ doc: docWith(stroke('a')) })
    vi.advanceTimersByTime(SAVE_DELAY_MS - 100)
    store.setState({ doc: docWith(stroke('a'), stroke('b')) })
    vi.advanceTimersByTime(SAVE_DELAY_MS - 1)
    expect(kv.data.has(STORAGE_KEY)).toBe(false)

    vi.advanceTimersByTime(1)
    expect((await loadDoc(kv))?.rootIds).toEqual(['a', 'b'])

    stop()
  })

  it('stops saving once stopped', () => {
    vi.useFakeTimers()
    const kv = memoryStore()
    const store = createStore<{ doc: Doc }>()(() => ({ doc: emptyDoc() }))
    const stop = startAutosave(store, kv)

    store.setState({ doc: docWith(stroke('a')) })
    stop()
    vi.advanceTimersByTime(SAVE_DELAY_MS * 2)

    expect(kv.data.has(STORAGE_KEY)).toBe(false)
  })

  it('ignores state changes that leave the doc alone', () => {
    vi.useFakeTimers()
    const kv = memoryStore()
    const store = createStore<{ doc: Doc; other: number }>()(() => ({ doc: emptyDoc(), other: 0 }))
    const stop = startAutosave(store, kv)

    store.setState({ other: 1 })
    vi.advanceTimersByTime(SAVE_DELAY_MS * 2)

    expect(kv.data.has(STORAGE_KEY)).toBe(false)
    stop()
  })
})
