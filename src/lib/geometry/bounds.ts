import type {
  GroupNode,
  NodeId,
  PathNode,
  ShapeNode,
  TextNode,
  Transform,
  VectorNode,
} from '../../types'
import { strokeOutlineBox } from '../strokePath'
import { pathSegments, type Cubic } from './pathData'
import { textHeight } from './textLayout'
import { absoluteTransform, composeTransform } from './transform'

/** Anything with x at 0 and y at 1: a [x, y] pair or a [x, y, pressure] point. */
export type Vec = { readonly 0: number; readonly 1: number }

export interface Box {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

const DEG = Math.PI / 180

// perfect-freehand's outline reaches 0.75 × size at full pressure (thinning 0.5).
const MAX_STROKE_REACH = 0.75

export function isIdentity(t: Transform): boolean {
  return t.x === 0 && t.y === 0 && t.rotation === 0 && t.scaleX === 1 && t.scaleY === 1
}

/** Local → canvas coordinates, in Konva's order: scale, then rotate, then translate. */
export function applyTransform(t: Transform, x: number, y: number): [number, number] {
  const sx = x * t.scaleX
  const sy = y * t.scaleY
  if (t.rotation === 0) return [sx + t.x, sy + t.y]
  const cos = Math.cos(t.rotation * DEG)
  const sin = Math.sin(t.rotation * DEG)
  return [sx * cos - sy * sin + t.x, sx * sin + sy * cos + t.y]
}

/** Canvas → local coordinates: undoes applyTransform. */
export function invertTransform(t: Transform, x: number, y: number): [number, number] {
  let dx = x - t.x
  let dy = y - t.y
  if (t.rotation !== 0) {
    const cos = Math.cos(t.rotation * DEG)
    const sin = Math.sin(t.rotation * DEG)
    ;[dx, dy] = [dx * cos + dy * sin, dy * cos - dx * sin]
  }
  return [dx / t.scaleX, dy / t.scaleY]
}

/** The box around a list of points, grown by `pad` on every side. */
export function pointsBox(points: ReadonlyArray<Vec>, pad = 0): Box {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const { 0: x, 1: y } of points) {
    if (x < minX) minX = x
    if (y < minY) minY = y
    if (x > maxX) maxX = x
    if (y > maxY) maxY = y
  }
  return { minX: minX - pad, minY: minY - pad, maxX: maxX + pad, maxY: maxY + pad }
}

export function boxesOverlap(a: Box, b: Box): boolean {
  return a.minX <= b.maxX && b.minX <= a.maxX && a.minY <= b.maxY && b.minY <= a.maxY
}

/** The canvas box around a local box after the transform. */
function transformedBox(t: Transform, local: Box): Box {
  return pointsBox([
    applyTransform(t, local.minX, local.minY),
    applyTransform(t, local.maxX, local.minY),
    applyTransform(t, local.maxX, local.maxY),
    applyTransform(t, local.minX, local.maxY),
  ])
}

/** Length and width of a line's arrowhead, in canvas units: it grows with the line. */
export function arrowHeadSize(strokeWidth: number): number {
  return strokeWidth * 4 + 10
}

/** How far a shape's visible outline reaches past its geometry, in local units. */
export function outlineReach(node: ShapeNode): number {
  return node.style.stroke === null ? 0 : node.style.strokeWidth / 2
}

/**
 * Where a cubic's coordinate along one axis turns, as t strictly between 0 and 1: the roots of its
 * derivative, a quadratic. bezier-js's bbox() solves the same quadratic but drops a root when the
 * quadratic term is float noise (a symmetric arch turned half a turn, say), so a tolerance treats
 * that as the straight line it is.
 */
function turningPoints(p0: number, p1: number, p2: number, p3: number): number[] {
  const a = p1 - p0
  const b = p2 - p1
  const c = p3 - p2
  const qa = a - 2 * b + c // derivative / 3 = qa t² + qb t + qc
  const qb = 2 * (b - a)
  const qc = a
  let roots: number[]
  if (Math.abs(qa) <= 1e-9 * (Math.abs(a) + Math.abs(b) + Math.abs(c))) {
    roots = qb === 0 ? [] : [-qc / qb]
  } else {
    const discriminant = qb * qb - 4 * qa * qc
    if (discriminant < 0) return []
    // The stable form of the quadratic formula, which never subtracts nearly equal numbers.
    const q = -0.5 * (qb + (qb < 0 ? -1 : 1) * Math.sqrt(discriminant))
    roots = q === 0 ? [0] : [q / qa, qc / q]
  }
  return roots.filter((t) => t > 0 && t < 1)
}

function cubicAt(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const u = 1 - t
  return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3
}

/** The exact box around a cubic segment, from its extrema rather than its control points. */
export function cubicBox(cubic: Cubic): Box {
  const [p0, p1, p2, p3] = cubic
  const points: Vec[] = [p0, p3]
  for (const axis of [0, 1] as const) {
    for (const t of turningPoints(p0[axis], p1[axis], p2[axis], p3[axis])) {
      points.push([cubicAt(p0[0], p1[0], p2[0], p3[0], t), cubicAt(p0[1], p1[1], p2[1], p3[1], t)])
    }
  }
  return pointsBox(points)
}

/**
 * A path's segments in canvas units, one list per contour: transforming the control points
 * transforms the curve.
 */
export function contourSegments(node: PathNode): Cubic[][] {
  const map = (x: number, y: number) => applyTransform(node.transform, x, y)
  return node.contours.map((c) => pathSegments(c.anchors, c.closed, map))
}

/** All of a path's segments in canvas units, contour after contour. */
export function canvasSegments(node: PathNode): Cubic[] {
  return contourSegments(node).flat()
}

function pathBounds(node: PathNode): Box | null {
  const t = node.transform
  const boxes = canvasSegments(node).map(cubicBox)
  if (boxes.length === 0) {
    // A pen path's first anchor, before it has a segment.
    const anchors = node.contours.flatMap((c) => c.anchors)
    if (anchors.length === 0) return null
    boxes.push(pointsBox(anchors.map((a) => applyTransform(t, a.x, a.y))))
  }
  // Boxed in canvas units, so the outline's reach scales here; paths bake their scale anyway.
  const pad = outlineReach(node) * Math.max(Math.abs(t.scaleX), Math.abs(t.scaleY))
  return {
    minX: Math.min(...boxes.map((b) => b.minX)) - pad,
    minY: Math.min(...boxes.map((b) => b.minY)) - pad,
    maxX: Math.max(...boxes.map((b) => b.maxX)) + pad,
    maxY: Math.max(...boxes.map((b) => b.maxY)) + pad,
  }
}

function shapeBounds(node: ShapeNode): Box | null {
  const t = node.transform
  const reach = outlineReach(node)
  switch (node.type) {
    case 'path':
      return pathBounds(node)
    case 'rect':
      return transformedBox(t, {
        minX: -reach,
        minY: -reach,
        maxX: node.width + reach,
        maxY: node.height + reach,
      })
    case 'ellipse': {
      // The exact box of a turned ellipse, from its half-axes.
      const a = (node.rx + reach) * Math.abs(t.scaleX)
      const b = (node.ry + reach) * Math.abs(t.scaleY)
      const cos = Math.cos(t.rotation * DEG)
      const sin = Math.sin(t.rotation * DEG)
      const hx = Math.hypot(a * cos, b * sin)
      const hy = Math.hypot(a * sin, b * cos)
      return { minX: t.x - hx, minY: t.y - hy, maxX: t.x + hx, maxY: t.y + hy }
    }
    case 'line': {
      const [x1, y1, x2, y2] = node.points
      // Round caps reach `reach` past the ends; arrowheads spread half their width to the sides.
      const arrows = node.arrowStart || node.arrowEnd
      const pad = arrows ? reach + arrowHeadSize(node.style.strokeWidth) / 2 : reach
      return transformedBox(
        t,
        pointsBox(
          [
            [x1, y1],
            [x2, y2],
          ],
          pad,
        ),
      )
    }
  }
}

/** A text node's box in its own coordinates: its width, and a line height per line. */
export function textBox(node: TextNode): Box {
  return { minX: 0, minY: 0, maxX: node.width, maxY: textHeight(node) }
}

const pathFillCache = new WeakMap<PathNode['contours'], Box | null>()

/** A path's curves boxed in its own coordinates; cached by its contours array. */
function localPathBox(node: PathNode): Box | null {
  const cached = pathFillCache.get(node.contours)
  if (cached !== undefined) return cached
  const boxes: Box[] = []
  for (const c of node.contours) {
    const segments = pathSegments(c.anchors, c.closed)
    if (segments.length > 0) boxes.push(...segments.map(cubicBox))
    else if (c.anchors.length > 0) boxes.push(pointsBox(c.anchors.map((a) => [a.x, a.y])))
  }
  const box = unionBoxes(boxes)
  pathFillCache.set(node.contours, box)
  return box
}

/**
 * The box a node's fill is laid out in, in the node's own coordinates: its geometry without the
 * outline. Gradient points are stored in units of this box, so they follow the node through
 * moves and resizes. A rectangle's is its size, an ellipse's its radii about its center, a
 * path's its curves' extrema, a freehand stroke's its drawn outline and a text's its width by its
 * lines. Lines and groups have no fill.
 */
export function fillBox(node: VectorNode): Box | null {
  switch (node.type) {
    case 'rect':
      return { minX: 0, minY: 0, maxX: node.width, maxY: node.height }
    case 'ellipse':
      return { minX: -node.rx, minY: -node.ry, maxX: node.rx, maxY: node.ry }
    case 'path':
      return localPathBox(node)
    case 'stroke':
      return strokeOutlineBox(node)
    case 'text':
      return textBox(node)
    case 'line':
    case 'group':
      return null
  }
}

export function unionBoxes(boxes: Iterable<Box | null>): Box | null {
  let union: Box | null = null
  for (const box of boxes) {
    if (!box) continue
    union = union
      ? {
          minX: Math.min(union.minX, box.minX),
          minY: Math.min(union.minY, box.minY),
          maxX: Math.max(union.maxX, box.maxX),
          maxY: Math.max(union.maxY, box.maxY),
        }
      : box
  }
  return union
}

type Nodes = Readonly<Record<NodeId, VectorNode>>

/** The group's visible descendants, depth first; they decide whether its cached box still holds. */
function visibleDescendants(nodes: Nodes, group: GroupNode, out: VectorNode[] = []): VectorNode[] {
  for (const id of group.childIds) {
    const child = nodes[id]
    if (!child || child.hidden) continue
    out.push(child)
    if (child.type === 'group') visibleDescendants(nodes, child, out)
  }
  return out
}

const groupCache = new WeakMap<GroupNode, { parts: VectorNode[]; box: Box | null }>()

/**
 * A group's box: its visible children boxed through the group's transform, so a turned group gets
 * the exact box of what it holds, not a box around a box. Cached until a descendant changes.
 */
function groupBounds(group: GroupNode, nodes: Nodes): Box | null {
  const parts = visibleDescendants(nodes, group)
  const cached = groupCache.get(group)
  if (
    cached &&
    cached.parts.length === parts.length &&
    cached.parts.every((part, i) => part === parts[i])
  ) {
    return cached.box
  }
  const box = unionBoxes(
    group.childIds.map((id) => {
      const child = nodes[id]
      if (!child || child.hidden) return null
      return nodeBounds(
        { ...child, transform: composeTransform(group.transform, child.transform) },
        nodes,
      )
    }),
  )
  groupCache.set(group, { parts, box })
  return box
}

const boundsCache = new WeakMap<VectorNode, Box | null>()

/**
 * Box around a node's ink, outlines included, in its parent's coordinates: the canvas for a
 * top-level node. A path is boxed by its curves' extrema, not by its anchors and handles, and a
 * text by its width and lines. A group needs `nodes` to find its children; without them, or with
 * nothing visible inside, it has no box.
 */
export function nodeBounds(node: VectorNode, nodes?: Nodes): Box | null {
  if (node.type === 'group') return nodes ? groupBounds(node, nodes) : null
  const cached = boundsCache.get(node)
  if (cached !== undefined) return cached

  let box: Box | null = null
  if (node.type === 'stroke') {
    if (node.points.length > 0) {
      box = transformedBox(node.transform, pointsBox(node.points, node.size * MAX_STROKE_REACH))
    }
  } else if (node.type === 'text') {
    box = transformedBox(node.transform, textBox(node))
  } else {
    box = shapeBounds(node)
  }
  boundsCache.set(node, box)
  return box
}

/** A node's box on the canvas, through every group it is in. */
export function canvasBounds(nodes: Nodes, id: NodeId): Box | null {
  const node = nodes[id]
  if (!node) return null
  if (node.parentId === null) return nodeBounds(node, nodes)
  return nodeBounds({ ...node, transform: absoluteTransform(nodes, id) }, nodes)
}

/**
 * A node's box on the canvas as it shows, which snapping goes by: canvasBounds, except that a
 * freehand stroke is boxed by its drawn outline rather than by how far its ink could reach at
 * full pressure, which is up to a third more for a mouse stroke. A group holds its visible
 * children's ink boxes.
 */
export function inkBounds(nodes: Nodes, id: NodeId): Box | null {
  const node = nodes[id]
  if (!node) return null
  if (node.type === 'stroke') {
    const local = strokeOutlineBox(node)
    return local && transformedBox(absoluteTransform(nodes, id), local)
  }
  if (node.type === 'group') {
    return unionBoxes(
      node.childIds.map((child) => (nodes[child]?.hidden ? null : inkBounds(nodes, child))),
    )
  }
  return canvasBounds(nodes, id)
}
