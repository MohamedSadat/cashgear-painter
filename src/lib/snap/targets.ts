import { boxesOverlap, inkBounds, unionBoxes, type Box } from '../geometry/bounds'
import { pageById, pageSubtree } from '../pages'
import type { Doc, NodeId } from '../../types'
import { sortLines, type SnapLine, type SnapTargets } from './snap'

export interface TargetOptions {
  area?: Box | null // only objects overlapping this box, such as the visible canvas, count
  grid?: number | null // grid spacing, when the grid is on
}

/**
 * The lines a drag on the page snaps to, collected once when it starts: the left, center and
 * right x and the top, middle and bottom y of every visible object on the page, plus the page's
 * edges and center. `exclude` are the objects being dragged: they, what they hold and the groups
 * they are in (whose boxes follow them) are no targets. Groups and the objects inside them are
 * targets each; a rotated object snaps by its axis-aligned box, and every object by its ink.
 */
export function collectTargets(
  doc: Doc,
  pageId: string,
  exclude: readonly NodeId[],
  { area = null, grid = null }: TargetOptions = {},
): SnapTargets {
  const x: SnapLine[] = []
  const y: SnapLine[] = []
  const add = ({ minX, minY, maxX, maxY }: Box) => {
    for (const at of [minX, (minX + maxX) / 2, maxX]) x.push({ at, from: minY, to: maxY })
    for (const at of [minY, (minY + maxY) / 2, maxY]) y.push({ at, from: minX, to: maxX })
  }

  const page = pageById(doc, pageId)
  if (page) add({ minX: 0, minY: 0, maxX: page.width, maxY: page.height })

  const excluded = new Set(exclude)
  const ancestors = new Set<NodeId>()
  for (const id of exclude) {
    for (let p = doc.nodes[id]?.parentId ?? null; p !== null; p = doc.nodes[p]?.parentId ?? null) {
      ancestors.add(p)
    }
  }
  // Groups come before their children, so a skipped group is known when its children come.
  const skipped = new Set<NodeId>()
  for (const node of pageSubtree(doc, pageId)) {
    const inSkipped = node.parentId !== null && skipped.has(node.parentId)
    if (node.hidden || excluded.has(node.id) || inSkipped) {
      skipped.add(node.id)
      continue
    }
    if (ancestors.has(node.id)) continue
    const box = inkBounds(doc.nodes, node.id)
    if (box && (!area || boxesOverlap(box, area))) add(box)
  }
  return { x: sortLines(x), y: sortLines(y), grid: grid !== null && grid > 0 ? grid : null }
}

/** The box around the nodes' ink on the canvas, which a drag of them snaps by. */
export function inkBox(doc: Doc, ids: readonly NodeId[]): Box | null {
  return unionBoxes(ids.map((id) => inkBounds(doc.nodes, id)))
}
