import { afterEach, describe, expect, it, vi } from 'vitest'
import { createStore } from 'zustand/vanilla'
import { createImageNode } from '../../store/editorStore'
import { emptyDoc, type AssetMeta, type Doc, type VectorNode } from '../../types'
import { AssetCache, RELEASE_DELAY_MS, assetsInUse, startAssetTracking } from './assets'

const A = 'a'.repeat(64)
const B = 'b'.repeat(64)
const C = 'c'.repeat(64)

const meta = (id: string): AssetMeta => ({
  id,
  mime: 'image/png',
  width: 10,
  height: 10,
  bytes: 3,
})

/** A cache whose storage holds `stored`, and whose URLs and images are counted stand-ins. */
function setup(stored: Record<string, Blob> = {}) {
  let urls = 0
  const live = new Set<string>()
  const decodes: ((ok: boolean) => void)[] = []
  const options = {
    load: vi.fn(async (id: string) => stored[id]),
    createUrl: vi.fn(() => {
      const url = `blob:${++urls}`
      live.add(url)
      return url
    }),
    revokeUrl: vi.fn((url: string) => void live.delete(url)),
    // Each decode waits until the test settles it.
    decode: vi.fn(
      (url: string) =>
        new Promise<HTMLImageElement>((resolve, reject) =>
          decodes.push((ok) =>
            ok ? resolve({ src: url } as HTMLImageElement) : reject(new Error('bad')),
          ),
        ),
    ),
    preview: vi.fn((image: HTMLImageElement) => `preview of ${image.src}`),
  }
  const cache = new AssetCache(options)
  const settle = async (ok = true) => {
    await vi.waitFor(() => expect(decodes.length).toBeGreaterThan(0))
    decodes.shift()!(ok)
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  return { cache, options, live, settle }
}

afterEach(() => vi.useRealTimers())

describe('AssetCache', () => {
  it('loads an asset from storage once, and keeps the same state until it changes', async () => {
    const blob = new Blob(['png'])
    const { cache, options, settle } = setup({ [A]: blob })
    expect(cache.state(A).status).toBe('idle')

    cache.request(A)
    cache.request(A)
    expect(cache.state(A).status).toBe('loading')
    await settle()

    const ready = cache.state(A)
    expect(ready).toMatchObject({ status: 'ready', image: { src: 'blob:1' } })
    expect(ready.preview).toBe('preview of blob:1')
    expect(cache.state(A)).toBe(ready)
    expect(options.load).toHaveBeenCalledOnce()
    expect(options.createUrl).toHaveBeenCalledOnce()
    expect(await cache.blob(A)).toBe(blob)
  })

  it('uses bytes just imported without going to storage', async () => {
    const blob = new Blob(['jpeg'])
    const { cache, options, settle } = setup()
    cache.put(A, blob)

    cache.request(A)
    await settle()

    expect(cache.state(A).status).toBe('ready')
    expect(options.load).not.toHaveBeenCalled()
    expect(await cache.blob(A)).toBe(blob)
  })

  it('marks an asset missing when its bytes are nowhere or not an image', async () => {
    const { cache, settle } = setup({ [B]: new Blob(['broken']) })
    cache.request(A)
    await vi.waitFor(() => expect(cache.state(A).status).toBe('missing'))
    expect(await cache.blob(A)).toBeNull()

    cache.request(B)
    await settle(false)
    expect(cache.state(B).status).toBe('missing')
  })

  it('lets go of unused assets, revoking their object URLs, and reloads them if asked', async () => {
    const { cache, options, live, settle } = setup({ [A]: new Blob(['a']), [B]: new Blob(['b']) })
    cache.request(A)
    await settle()
    cache.request(B)
    await settle()
    expect(live.size).toBe(2)
    const listener = vi.fn()
    cache.subscribe(listener)

    cache.release(new Set([A]))

    expect(cache.held()).toEqual([A])
    expect(live).toEqual(new Set(['blob:1']))
    expect(cache.state(B).status).toBe('idle')
    expect(listener).toHaveBeenCalledOnce()
    // Still stored, it comes back when needed again.
    cache.request(B)
    await settle()
    expect(cache.state(B).status).toBe('ready')
    expect(options.load).toHaveBeenCalledTimes(3)
  })

  it('revokes the URL of an asset let go of while it decoded', async () => {
    const { cache, live, settle } = setup({ [A]: new Blob(['a']) })
    cache.request(A)
    await vi.waitFor(() => expect(live.size).toBe(1))

    cache.release(new Set())
    await settle()

    expect(live.size).toBe(0)
    expect(cache.held()).toEqual([])
  })

  it('waits until assets are drawable or known to be missing', async () => {
    const { cache, settle } = setup({ [A]: new Blob(['a']) })
    let done = false
    const waiting = cache.whenSettled([A, B, A]).then(() => (done = true))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(done).toBe(false)

    await settle()
    await waiting

    expect(cache.state(A).status).toBe('ready')
    expect(cache.state(B).status).toBe('missing')
  })
})

/** A doc with an image of each asset on its page. */
function docShowing(...ids: string[]): Doc {
  const doc = emptyDoc()
  for (const id of ids) {
    const node = createImageNode(meta(id), { x: 0, y: 0, width: 10, height: 10 })
    doc.nodes[node.id] = node
    doc.pages[0].rootIds.push(node.id)
    doc.assets[id] = meta(id)
  }
  return doc
}

describe('assets in use', () => {
  it('counts the doc, its undo and redo history, an open gesture and the clipboard', () => {
    const clipboard: VectorNode[] = [createImageNode(meta(C), { x: 0, y: 0, width: 1, height: 1 })]
    const used = assetsInUse({
      doc: docShowing(A),
      past: [docShowing(B)],
      future: [],
      gestureStart: docShowing('d'.repeat(64)),
      clipboard,
    })
    expect([...used].sort()).toEqual([A, B, C, 'd'.repeat(64)])
  })

  it('lets go of assets a little after nothing uses them any more', async () => {
    vi.useFakeTimers()
    const { cache, live, settle } = setup({ [A]: new Blob(['a']), [B]: new Blob(['b']) })
    const store = createStore(() => ({
      doc: docShowing(A, B),
      past: [] as Doc[],
      future: [] as Doc[],
      gestureStart: null as Doc | null,
      clipboard: [] as VectorNode[],
    }))
    const stop = startAssetTracking(store, cache)
    vi.useRealTimers()
    cache.request(A)
    await settle()
    cache.request(B)
    await settle()
    vi.useFakeTimers()

    // B's image is deleted, but undo can bring it back: kept.
    const before = store.getState().doc
    store.setState({ doc: docShowing(A), past: [before] })
    vi.advanceTimersByTime(RELEASE_DELAY_MS)
    expect(live.size).toBe(2)

    // The history is gone: let go of.
    store.setState({ past: [] })
    vi.advanceTimersByTime(RELEASE_DELAY_MS - 1)
    expect(live.size).toBe(2)
    vi.advanceTimersByTime(1)
    expect(cache.held()).toEqual([A])
    expect(live.size).toBe(1)
    stop()
  })
})
