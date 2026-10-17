import type { KonvaEventObject } from 'konva/lib/Node'
import { Group, Image as KonvaImage, Rect } from 'react-konva'
import { absoluteTransform } from '../lib/geometry/transform'
import { IMAGE_PLACEHOLDER_COLOR } from '../lib/images/assetRefs'
import { useAsset } from '../lib/images/assets'
import { moveBoxEdges, moveFrame, type CropDraft, type CropEdge } from '../lib/images/crop'
import { useEditorStore, zoomOf } from '../store/editorStore'
import type { AssetMeta, ImageNode } from '../types'
import { ACCENT, ANCHOR_SIZE } from './overlayStyle'

const store = () => useEditorStore.getState()

// How much of the image outside the box still shows, so it can be dragged into place.
const OUTSIDE_OPACITY = 0.35

interface Handle {
  name: string
  edges: CropEdge[] // the box edges it moves
  at: [number, number] // where it sits along the box, 0..1 each way
}

const HANDLES: Handle[] = [
  { name: 'top-left', edges: ['top', 'left'], at: [0, 0] },
  { name: 'top-center', edges: ['top'], at: [0.5, 0] },
  { name: 'top-right', edges: ['top', 'right'], at: [1, 0] },
  { name: 'middle-right', edges: ['right'], at: [1, 0.5] },
  { name: 'bottom-right', edges: ['bottom', 'right'], at: [1, 1] },
  { name: 'bottom-center', edges: ['bottom'], at: [0.5, 1] },
  { name: 'bottom-left', edges: ['bottom', 'left'], at: [0, 1] },
  { name: 'middle-left', edges: ['left'], at: [0, 0.5] },
]

interface CropViewProps {
  node: ImageNode
  asset: AssetMeta
  draft: CropDraft
}

/** The image in crop mode, in the node's own coordinates: see CropOverlay. */
function CropView({ node, asset, draft }: CropViewProps) {
  const { image } = useAsset(node.assetId)
  const zoom = useEditorStore(zoomOf)
  const nodes = useEditorStore((s) => s.doc.nodes)
  const t = absoluteTransform(nodes, node.id)
  const { frame, box } = draft
  // Handles keep their size on screen, whatever the zoom and the node's scale.
  const size = ANCHOR_SIZE / (zoom * Math.max(Math.abs(t.scaleX), Math.abs(t.scaleY), 1e-6))
  const sx = frame.width / asset.width
  const sy = frame.height / asset.height
  const opacity = node.style.opacity

  // The store's draft, which a drag has moved on since this render.
  const current = () => store().cropping ?? draft

  const panImage = (e: KonvaEventObject<DragEvent>) => {
    const next = moveFrame(current(), e.target.x(), e.target.y())
    e.target.position({ x: next.frame.x, y: next.frame.y })
    store().setCropping(next)
  }

  const moveEdges = (handle: Handle) => (e: KonvaEventObject<DragEvent>) => {
    const next = moveBoxEdges(current(), handle.edges, e.target.x(), e.target.y())
    e.target.position({
      x: next.box.x + next.box.width * handle.at[0],
      y: next.box.y + next.box.height * handle.at[1],
    })
    store().setCropping(next)
  }

  return (
    <Group x={t.x} y={t.y} rotation={t.rotation} scaleX={t.scaleX} scaleY={t.scaleY}>
      {/* The whole image, dimmed: dragging it moves it inside the box. */}
      <KonvaImage
        name="crop-image"
        image={image ?? undefined}
        fill={image ? undefined : IMAGE_PLACEHOLDER_COLOR}
        {...frame}
        opacity={opacity * OUTSIDE_OPACITY}
        draggable
        onDragMove={panImage}
        onDragEnd={panImage}
      />
      {/* The part that will show, as it will. */}
      <KonvaImage
        image={image ?? undefined}
        fill={image ? undefined : IMAGE_PLACEHOLDER_COLOR}
        {...box}
        cropX={(box.x - frame.x) / sx}
        cropY={(box.y - frame.y) / sy}
        cropWidth={box.width / sx}
        cropHeight={box.height / sy}
        opacity={opacity}
        listening={false}
      />
      <Rect
        name="crop-box"
        {...box}
        stroke={ACCENT}
        strokeWidth={1}
        strokeScaleEnabled={false}
        listening={false}
      />
      {HANDLES.map((handle) => (
        <Rect
          key={handle.name}
          name={`crop-${handle.name}`}
          x={box.x + box.width * handle.at[0]}
          y={box.y + box.height * handle.at[1]}
          width={size}
          height={size}
          offsetX={size / 2}
          offsetY={size / 2}
          cornerRadius={size / 4}
          fill="#ffffff"
          stroke={ACCENT}
          strokeWidth={1}
          strokeScaleEnabled={false}
          draggable
          onDragMove={moveEdges(handle)}
          onDragEnd={moveEdges(handle)}
        />
      ))}
    </Group>
  )
}

/**
 * Crop mode on the overlay layer: the whole image dimmed, the part that will show at full
 * strength inside a box, and handles on the box's corners and sides. The handles crop; dragging
 * the image moves it inside the box. The box always stays inside the image. Everything is laid
 * out through the image's transform, so a turned image crops along its own sides.
 */
export function CropOverlay() {
  const draft = useEditorStore((s) => s.cropping)
  const node = useEditorStore((s) => (s.cropping ? s.doc.nodes[s.cropping.id] : undefined))
  const asset = useEditorStore((s) =>
    node?.type === 'image' ? s.doc.assets[node.assetId] : undefined,
  )
  if (!draft || node?.type !== 'image' || !asset) return null
  return <CropView node={node} asset={asset} draft={draft} />
}
