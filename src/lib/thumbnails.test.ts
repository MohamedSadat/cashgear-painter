import { afterEach, describe, expect, it, vi } from 'vitest'
import { createStore } from 'zustand/vanilla'
import { createStrokeNode } from '../store/editorStore'
import { emptyDoc, newPage, type Doc } from '../types'
import { THUMBNAIL_DELAY_MS, startThumbnails, thumbnailOf } from './thumbnails'

const stroke = (id: string) =>
  createStrokeNode([[0, 0, 0.5]], { color: '#000000', size: 8, usesPressure: false }, id)

function twoPages(): Doc {
  const doc = emptyDoc()
  doc.pages.push(newPage('p2', 'Page 2'))
  return doc
}

/** A doc with a stroke added on the page. */
function withStroke(doc: Doc, pageId: string, id: string): Doc {
  return {
    ...doc,
    nodes: { ...doc.nodes, [id]: stroke(id) },
    pages: doc.pages.map((page) =>
      page.id === pageId ? { ...page, rootIds: [...page.rootIds, id] } : page,
    ),
  }
}

/** A thumbnail store and a renderer that names each drawing, counting them. */
function setup(doc = twoPages()) {
  const store = createStore<{ doc: Doc; currentPageId: string }>()(() => ({
    doc,
    currentPageId: 'page-1',
  }))
  let drawings = 0
  const render = vi.fn((_doc: Doc, pageId: string) => `${pageId}#${++drawings}`)
  const revoke = vi.fn()
  const stop = startThumbnails(store, { render, revoke })
  return { store, render, revoke, stop }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('thumbnails', () => {
  it('draws every page once the editor has shown', () => {
    vi.useFakeTimers()
    const { render, stop } = setup()
    expect(thumbnailOf('page-1')).toBeNull()

    vi.advanceTimersByTime(0)
    expect(render).toHaveBeenCalledTimes(2)
    expect(thumbnailOf('page-1')).toBe('page-1#1')
    expect(thumbnailOf('p2')).toBe('p2#2')
    stop()
  })

  it(`redraws a changed page ${THUMBNAIL_DELAY_MS} ms after the last edit, and only that page`, () => {
    vi.useFakeTimers()
    const { store, render, revoke, stop } = setup()
    vi.advanceTimersByTime(0)

    store.setState({ doc: withStroke(store.getState().doc, 'page-1', 'a') })
    vi.advanceTimersByTime(THUMBNAIL_DELAY_MS - 100)
    store.setState({ doc: withStroke(store.getState().doc, 'page-1', 'b') })
    vi.advanceTimersByTime(THUMBNAIL_DELAY_MS - 1)
    expect(render).toHaveBeenCalledTimes(2)

    vi.advanceTimersByTime(1)
    expect(render).toHaveBeenCalledTimes(3)
    expect(thumbnailOf('page-1')).toBe('page-1#3')
    expect(revoke).toHaveBeenCalledWith('page-1#1')
    stop()
  })

  it('redraws the page just left at once, and draws a new page at once', () => {
    vi.useFakeTimers()
    const { store, render, stop } = setup()
    vi.advanceTimersByTime(0)

    store.setState({ doc: withStroke(store.getState().doc, 'page-1', 'a') })
    store.setState({ currentPageId: 'p2' })
    expect(thumbnailOf('page-1')).toBe('page-1#3')

    const { doc } = store.getState()
    store.setState({ doc: { ...doc, pages: [...doc.pages, newPage('p3', 'Page 3')] } })
    expect(thumbnailOf('p3')).toBe('p3#4')
    vi.advanceTimersByTime(THUMBNAIL_DELAY_MS)
    expect(render).toHaveBeenCalledTimes(4)
    stop()
  })

  it('lets go of deleted pages’ images, and of all of them once stopped', () => {
    vi.useFakeTimers()
    const { store, revoke, stop } = setup()
    vi.advanceTimersByTime(0)

    const { doc } = store.getState()
    store.setState({ doc: { ...doc, pages: [doc.pages[0]] } })
    vi.advanceTimersByTime(THUMBNAIL_DELAY_MS)
    expect(revoke).toHaveBeenCalledWith('p2#2')
    expect(thumbnailOf('p2')).toBeNull()

    stop()
    expect(revoke).toHaveBeenCalledWith('page-1#1')
    expect(thumbnailOf('page-1')).toBeNull()
  })
})
