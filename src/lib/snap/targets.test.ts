import { describe, expect, it } from 'vitest'
import { DEFAULT_SHAPE_STYLE, createGroupNode, createRectNode } from '../../store/editorStore'
import { emptyDoc, newPage, type Doc, type NodeOf } from '../../types'
import { GRID_SIZE } from './snap'
import { collectTargets } from './targets'

// No outline, so a rect's box is its geometry.
const style = {
  ...DEFAULT_SHAPE_STYLE,
  stroke: null,
  fill: { kind: 'solid' as const, color: '#000' },
}

const rect = (id: string, x: number, y: number, width = 100, height = 100): NodeOf<'rect'> =>
  createRectNode({ x, y, width, height }, style, id)

/**
 * Page 1 (1600 × 1000) holds rect 'a' at (100, 100) and group 'g' with rects 'b' at (500, 100)
 * and 'c' at (700, 100); page 2 holds rect 'd'.
 */
function sample(): Doc {
  const doc = emptyDoc()
  doc.nodes.a = rect('a', 100, 100)
  doc.nodes.g = createGroupNode(['b', 'c'], null, 'g')
  doc.nodes.b = { ...rect('b', 500, 100), parentId: 'g' }
  doc.nodes.c = { ...rect('c', 700, 100), parentId: 'g' }
  doc.nodes.d = rect('d', 1000, 600)
  doc.pages[0].rootIds = ['a', 'g']
  doc.pages.push({ ...newPage('p2', 'Page 2'), rootIds: ['d'] })
  return doc
}

const xs = (doc: Doc, exclude: string[] = [], pageId = 'page-1') =>
  collectTargets(doc, pageId, exclude).x.map((line) => line.at)

describe('collectTargets', () => {
  it('has the page edges and center, with lines as long as the page', () => {
    const targets = collectTargets(emptyDoc(), 'page-1', [])
    expect(targets.x).toEqual([
      { at: 0, from: 0, to: 1000 },
      { at: 800, from: 0, to: 1000 },
      { at: 1600, from: 0, to: 1000 },
    ])
    expect(targets.y.map((line) => line.at)).toEqual([0, 500, 1000])
    expect(targets.grid).toBeNull()
  })

  it("has every visible object's edges and center, groups and their children each, sorted", () => {
    const doc = sample()
    // a: 100 150 200; g: 500 650 800; b: 500 550 600; c: 700 750 800; page: 0 800 1600.
    expect(xs(doc)).toEqual([
      0, 100, 150, 200, 500, 500, 550, 600, 650, 700, 750, 800, 800, 800, 1600,
    ])
    const a = collectTargets(doc, 'page-1', []).x.find((line) => line.at === 100)
    expect(a).toEqual({ at: 100, from: 100, to: 200 })
    // Page 2 has only its own object.
    expect(xs(doc, [], 'p2')).toEqual([0, 800, 1000, 1050, 1100, 1600])
  })

  it('leaves out hidden objects and what hidden groups hold', () => {
    const doc = sample()
    doc.nodes.a = { ...doc.nodes.a, hidden: true }
    doc.nodes.g = { ...doc.nodes.g, hidden: true }
    expect(xs(doc)).toEqual([0, 800, 1600])
  })

  it('keeps locked objects: they still show', () => {
    const doc = sample()
    doc.nodes.a = { ...doc.nodes.a, locked: true }
    expect(xs(doc)).toContain(150)
  })

  it('leaves out the dragged objects, what they hold and the groups they are in', () => {
    const doc = sample()
    // Dragging the group drops it and its children.
    expect(xs(doc, ['g'])).toEqual([0, 100, 150, 200, 800, 1600])
    // Dragging a child drops it and the group, whose box follows it, but keeps its sibling.
    expect(xs(doc, ['b'])).toEqual([0, 100, 150, 200, 700, 750, 800, 800, 1600])
  })

  it('snaps a turned object by its axis-aligned box', () => {
    const doc = emptyDoc()
    doc.nodes.r = {
      ...rect('r', 100, 100),
      transform: { ...rect('r', 100, 100).transform, rotation: 45 },
    }
    doc.pages[0].rootIds = ['r']
    const half = 100 / Math.SQRT2
    const lines = collectTargets(doc, 'page-1', []).x.map((line) => line.at)
    expect(lines[1]).toBeCloseTo(100 - half)
    expect(lines[3]).toBeCloseTo(100 + half)
  })

  it('keeps only objects in the area, and passes the grid on', () => {
    const doc = sample()
    const area = { minX: 0, minY: 0, maxX: 450, maxY: 1000 }
    const targets = collectTargets(doc, 'page-1', [], { area, grid: GRID_SIZE })
    // The page's lines always count; of the objects only 'a' is in the area.
    expect(targets.x.map((line) => line.at)).toEqual([0, 100, 150, 200, 800, 1600])
    expect(targets.grid).toBe(GRID_SIZE)
  })
})
