import { memo } from 'react'
import { Arrow, Ellipse, Group, Image as KonvaImage, Path, Rect, Text } from 'react-konva'
import { arrowHeadSize } from '../lib/geometry/bounds'
import { cachedPathData } from '../lib/geometry/pathData'
import { IMAGE_PLACEHOLDER_COLOR } from '../lib/images/assetRefs'
import { useAsset } from '../lib/images/assets'
import { TEXT_LINE_HEIGHT } from '../lib/geometry/textLayout'
import { nodeKonvaFill } from '../lib/paint/toKonva'
import { cachedStrokePath, strokeToPath } from '../lib/strokePath'
import { useEditorStore, zoomOf } from '../store/editorStore'
import type { GroupNode, ImageNode, NodeId, ShapeNode, TextNode, VectorNode } from '../types'

const DIMMED_OPACITY = 0.3
// Thin strokes are easy to grab: the hit area reaches this many screen pixels around the ink.
const HIT_STROKE_PX = 12

/** The Konva attributes every node shares: its id, transform, opacity and whether it is picked. */
interface CommonProps {
  id: string
  x: number
  y: number
  rotation: number
  scaleX: number
  scaleY: number
  opacity: number
  listening: boolean
}

/**
 * Rectangles, ellipses, lines and paths. Their outlines are in canvas units and scale with the
 * zoom, so the hit outline is recomputed per zoom: at least HIT_STROKE_PX on screen, and never
 * thinner than the visible one. Only these re-render on zoom, not every freehand stroke.
 */
function ShapeView({ node, common }: { node: ShapeNode; common: CommonProps }) {
  const zoom = useEditorStore(zoomOf)
  const { style } = node
  const outline = style.stroke === null ? 0 : style.strokeWidth
  const paint = {
    ...common,
    stroke: style.stroke ?? undefined,
    strokeWidth: style.strokeWidth,
    hitStrokeWidth: Math.max(outline, zoom > 0 ? HIT_STROKE_PX / zoom : HIT_STROKE_PX),
  }
  // Konva's hit canvas fills every fill-enabled shape, so an unfilled one turns filling off to be
  // picked on its outline only. A gradient is laid out in the node's own coordinates.
  const fill = { ...nodeKonvaFill(node), fillEnabled: style.fill !== null }

  switch (node.type) {
    case 'path':
      // Miter joins and round caps, so a converted rectangle keeps its corners and a converted
      // line its round ends. The fill rule decides which contours cut holes, here and on the hit
      // canvas alike.
      return (
        <Path
          {...paint}
          {...fill}
          data={cachedPathData(node)}
          fillRule={node.fillRule}
          lineJoin="miter"
          lineCap="round"
        />
      )
    case 'rect':
    case 'ellipse': {
      return node.type === 'rect' ? (
        <Rect
          {...paint}
          {...fill}
          width={node.width}
          height={node.height}
          cornerRadius={node.cornerRadius}
        />
      ) : (
        <Ellipse {...paint} {...fill} radiusX={node.rx} radiusY={node.ry} />
      )
    }
    case 'line': {
      const head = arrowHeadSize(style.strokeWidth)
      return (
        <Arrow
          {...paint}
          points={node.points}
          // Arrowheads are filled with the line's color.
          fill={style.stroke ?? undefined}
          fillEnabled={style.stroke !== null}
          pointerAtBeginning={node.arrowStart}
          pointerAtEnding={node.arrowEnd}
          pointerLength={head}
          pointerWidth={head}
          lineCap="round"
          lineJoin="round"
        />
      )
    }
  }
}

/**
 * Text wrapped at words in its fixed width. Konva picks it anywhere in its box. While the
 * textarea overlay edits it, the Konva text hides so the two don't show at once.
 */
function TextView({ node, common }: { node: TextNode; common: CommonProps }) {
  const editing = useEditorStore((s) => s.editingText === node.id)
  return (
    <Text
      {...common}
      visible={!editing}
      text={node.text}
      fontFamily={node.fontFamily}
      fontSize={node.fontSize}
      fontStyle={node.fontStyle}
      align={node.align}
      width={node.width}
      wrap="word"
      lineHeight={TEXT_LINE_HEIGHT}
      {...nodeKonvaFill(node)}
    />
  )
}

/**
 * An image stretched over its box, showing its crop. A gray box stands in while the image loads,
 * or when its bytes can't be found; Konva picks either anywhere in the box. In crop mode the
 * overlay draws it instead.
 */
function ImageView({ node, common }: { node: ImageNode; common: CommonProps }) {
  const { image } = useAsset(node.assetId)
  const cropping = useEditorStore((s) => s.cropping?.id === node.id)
  const { crop } = node
  return (
    <KonvaImage
      {...common}
      visible={!cropping}
      image={image ?? undefined}
      width={node.width}
      height={node.height}
      // A crop of 0 × 0 draws the whole image.
      cropX={crop?.x ?? 0}
      cropY={crop?.y ?? 0}
      cropWidth={crop?.width ?? 0}
      cropHeight={crop?.height ?? 0}
      fill={image ? undefined : IMAGE_PLACEHOLDER_COLOR}
    />
  )
}

/** A child of a group, read from the store, so a changed child re-renders without its group. */
function ChildView({ id }: { id: NodeId }) {
  const node = useEditorStore((s) => s.doc.nodes[id])
  const dimmed = useEditorStore((s) => s.erasing.includes(id))
  return node ? <NodeView node={node} dimmed={dimmed} /> : null
}

/** A Konva Group: its transform and opacity apply to its children; locked, none of them is picked. */
function GroupView({ node, common }: { node: GroupNode; common: CommonProps }) {
  return (
    <Group {...common}>
      {node.childIds.map((id) => (
        <ChildView key={id} id={id} />
      ))}
    </Group>
  )
}

interface NodeViewProps {
  node: VectorNode
  dimmed?: boolean // touched by the eraser, about to be deleted
  isDraft?: boolean // still being drawn
}

/**
 * One Konva shape per node, named by the node id so tools can tell what was hit; a group is a
 * Konva Group of its children's views. Hits only count while the content layer listens, which
 * only tools that pick nodes turn on. Hidden nodes aren't drawn, and locked ones aren't picked.
 */
export const NodeView = memo(function NodeView({
  node,
  dimmed = false,
  isDraft = false,
}: NodeViewProps) {
  if (node.hidden) return null
  const { transform, style } = node
  const common: CommonProps = {
    id: node.id,
    x: transform.x,
    y: transform.y,
    rotation: transform.rotation,
    scaleX: transform.scaleX,
    scaleY: transform.scaleY,
    opacity: style.opacity * (dimmed ? DIMMED_OPACITY : 1),
    listening: !node.locked && !isDraft,
  }

  switch (node.type) {
    case 'stroke':
      return (
        <Path
          {...common}
          data={isDraft ? strokeToPath(node, false) : cachedStrokePath(node)}
          {...nodeKonvaFill(node)}
          perfectDrawEnabled={false}
          // The outline is a fill, so the hit stroke has no visible twin; unscaled, it stays
          // HIT_STROKE_PX on screen at any zoom and any stroke scale.
          hitStrokeWidth={HIT_STROKE_PX}
          strokeScaleEnabled={false}
        />
      )
    // With fill and outline both see-through, Konva's default perfect drawing composites the shape
    // once, as SVG's opacity does, instead of showing the fill through the outline.
    case 'rect':
    case 'ellipse':
    case 'line':
    case 'path':
      return <ShapeView node={node} common={common} />
    case 'text':
      return <TextView node={node} common={common} />
    case 'group':
      return <GroupView node={node} common={common} />
    case 'image':
      return <ImageView node={node} common={common} />
  }
})
