import { describe, expect, it } from 'vitest'
import { createGroupNode, createStrokeNode } from '../store/editorStore'
import { emptyDoc, newPage, type Doc, type StrokeNode } from '../types'
import {
  MAX_PAGE_SIZE,
  MIN_PAGE_SIZE,
  clampPageSize,
  mmToPx,
  nextPageName,
  pageOf,
  pageSubtree,
  presetOf,
  pxToMm,
  touchedPages,
} from './pages'

const stroke = (id: string): StrokeNode =>
  createStrokeNode([[0, 0, 0.5]], { color: '#000000', size: 8, usesPressure: false }, id)

/** Page 1 holds stroke 'a' and group 'g' with stroke 'b'; page 2 holds stroke 'c'. */
function twoPages(): Doc {
  const doc = emptyDoc()
  doc.nodes.a = stroke('a')
  doc.nodes.g = createGroupNode(['b'], null, 'g')
  doc.nodes.b = { ...stroke('b'), parentId: 'g' }
  doc.nodes.c = stroke('c')
  doc.pages[0].rootIds = ['a', 'g']
  doc.pages.push({ ...newPage('p2', 'Page 2'), rootIds: ['c'] })
  return doc
}

describe('page sizes', () => {
  it('converts millimetres at 96 pixels per inch', () => {
    expect([mmToPx(210), mmToPx(297)]).toEqual([794, 1123])
    expect(pxToMm(794)).toBe(210.1)
    expect(pxToMm(96)).toBe(25.4)
  })

  it(`keeps a side between ${MIN_PAGE_SIZE} and ${MAX_PAGE_SIZE} whole pixels`, () => {
    expect(clampPageSize(0)).toBe(MIN_PAGE_SIZE)
    expect(clampPageSize(99999)).toBe(MAX_PAGE_SIZE)
    expect(clampPageSize(100.6)).toBe(101)
    expect(clampPageSize(Number.NaN)).toBe(MIN_PAGE_SIZE)
  })

  it('names the preset a size is, as named or turned a quarter', () => {
    expect(presetOf(794, 1123)).toMatchObject({ preset: { id: 'a4' }, turned: false })
    expect(presetOf(1123, 794)).toMatchObject({ preset: { id: 'a4' }, turned: true })
    expect(presetOf(1920, 1080)).toMatchObject({ preset: { id: 'presentation' }, turned: false })
    expect(presetOf(1600, 1000)).toMatchObject({ preset: { id: 'painter' } })
    expect(presetOf(500, 500)).toBeNull()
  })

  it('names a new page one past the highest Page N and the page count', () => {
    expect(nextPageName([newPage('a', 'Page 1')])).toBe('Page 2')
    expect(nextPageName([newPage('a', 'Page 7'), newPage('b', 'Cover')])).toBe('Page 8')
    expect(nextPageName([newPage('a', 'Cover'), newPage('b', 'Back')])).toBe('Page 3')
  })
})

describe('page lookups', () => {
  it('finds the page of a node through its groups', () => {
    const doc = twoPages()
    expect(pageOf(doc, 'a')).toBe('page-1')
    expect(pageOf(doc, 'b')).toBe('page-1')
    expect(pageOf(doc, 'c')).toBe('p2')
    expect(pageOf(doc, 'missing')).toBeNull()
  })

  it('lists a page’s nodes bottom to top, each group before its children', () => {
    const doc = twoPages()
    expect(pageSubtree(doc, 'page-1').map((node) => node.id)).toEqual(['a', 'g', 'b'])
    expect(pageSubtree(doc, 'p2').map((node) => node.id)).toEqual(['c'])
    expect(pageSubtree(doc, 'nope')).toEqual([])
  })

  it('tells which pages a change touched', () => {
    const doc = twoPages()
    expect(touchedPages(doc, doc)).toEqual([])
    // A node in a group on page 1 changed.
    const edited = { ...doc, nodes: { ...doc.nodes, b: { ...doc.nodes.b, name: 'B' } } }
    expect(touchedPages(doc, edited)).toEqual(['page-1'])
    // Page 2 resized; a new page added; the pages reordered only.
    const resized = { ...doc, pages: [doc.pages[0], { ...doc.pages[1], width: 500 }] }
    expect(touchedPages(doc, resized)).toEqual(['p2'])
    const added = { ...doc, pages: [...doc.pages, newPage('p3', 'Page 3')] }
    expect(touchedPages(doc, added)).toEqual(['p3'])
    expect(touchedPages(doc, { ...doc, pages: [doc.pages[1], doc.pages[0]] })).toEqual([])
  })
})
