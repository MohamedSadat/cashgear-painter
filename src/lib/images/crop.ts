import type { AssetMeta, CropRect, ImageNode, Transform } from '../../types'
import { applyTransform } from '../geometry/bounds'

/** An axis-aligned rectangle in an image node's own coordinates. */
export interface LocalRect {
  x: number
  y: number
  width: number
  height: number
}

/**
 * Crop mode's working state for one image, in the node's own coordinates as they were when crop
 * mode began: `frame` is where the whole image lies, `box` the part that will show. The node
 * itself doesn't change until the crop is applied.
 */
export interface CropDraft {
  id: string
  frame: LocalRect
  box: LocalRect
}

// The smallest crop box, in local units.
export const MIN_CROP_SIZE = 1

type Size = Pick<AssetMeta, 'width' | 'height'>

/** The part of the image the node shows, in the image's pixels: its crop, or all of it. */
export function cropOf(node: ImageNode, asset: Size): CropRect {
  return node.crop ?? { x: 0, y: 0, width: asset.width, height: asset.height }
}

/**
 * Where the whole image lies in the node's own coordinates: the shown part fills 0..width ×
 * 0..height, and the rest reaches past it at the same scale.
 */
export function imageFrame(node: ImageNode, asset: Size): LocalRect {
  const crop = cropOf(node, asset)
  const sx = node.width / crop.width
  const sy = node.height / crop.height
  // + 0 turns -0 into 0.
  return {
    x: -crop.x * sx + 0,
    y: -crop.y * sy + 0,
    width: asset.width * sx,
    height: asset.height * sy,
  }
}

/** Crop mode's starting state: the whole image, and the part the node shows now. */
export function startDraft(node: ImageNode, asset: Size): CropDraft {
  return {
    id: node.id,
    frame: imageFrame(node, asset),
    box: { x: 0, y: 0, width: node.width, height: node.height },
  }
}

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n))

/**
 * The draft with the image moved so its top-left corner is at (x, y), within reach of the box:
 * the box always stays inside the image.
 */
export function moveFrame(draft: CropDraft, x: number, y: number): CropDraft {
  const { frame, box } = draft
  return {
    ...draft,
    frame: {
      ...frame,
      x: clamp(x, box.x + box.width - frame.width, box.x),
      y: clamp(y, box.y + box.height - frame.height, box.y),
    },
  }
}

export type CropEdge = 'left' | 'right' | 'top' | 'bottom'

/**
 * The draft with the box's `edges` moved to the point (x, y), kept inside the image and at least
 * MIN_CROP_SIZE wide and high. The image stays where it is.
 */
export function moveBoxEdges(
  draft: CropDraft,
  edges: readonly CropEdge[],
  x: number,
  y: number,
): CropDraft {
  const { frame, box } = draft
  let left = box.x
  let top = box.y
  let right = box.x + box.width
  let bottom = box.y + box.height
  const min = Math.min(MIN_CROP_SIZE, frame.width, frame.height)
  if (edges.includes('left')) left = clamp(x, frame.x, right - min)
  if (edges.includes('right')) right = clamp(x, left + min, frame.x + frame.width)
  if (edges.includes('top')) top = clamp(y, frame.y, bottom - min)
  if (edges.includes('bottom')) bottom = clamp(y, top + min, frame.y + frame.height)
  return { ...draft, box: { x: left, y: top, width: right - left, height: bottom - top } }
}

// Float noise, such as 0.30000000000000004 image pixels, is rounded away.
const clean = (n: number) => Math.round(n * 1e6) / 1e6

/**
 * The node changes that apply a draft: the box becomes the node's size and its top-left corner
 * the node's position, turned with it, and the image under the box its crop. A crop of the whole
 * image is null.
 */
export function applyDraft(
  node: ImageNode,
  asset: Size,
  { frame, box }: CropDraft,
): Pick<ImageNode, 'transform' | 'width' | 'height' | 'crop'> {
  const sx = frame.width / asset.width
  const sy = frame.height / asset.height
  const crop: CropRect = {
    x: clean((box.x - frame.x) / sx),
    y: clean((box.y - frame.y) / sy),
    width: clean(box.width / sx),
    height: clean(box.height / sy),
  }
  const whole =
    crop.x === 0 && crop.y === 0 && crop.width === asset.width && crop.height === asset.height
  const [x, y] = applyTransform(node.transform, box.x, box.y)
  const transform: Transform = { ...node.transform, x, y }
  return { transform, width: box.width, height: box.height, crop: whole ? null : crop }
}

/**
 * The node changes that show the whole image again at the scale it has, the part it showed
 * staying where it is on the canvas; null when it isn't cropped.
 */
export function resetCrop(
  node: ImageNode,
  asset: Size,
): Pick<ImageNode, 'transform' | 'width' | 'height' | 'crop'> | null {
  if (node.crop === null) return null
  const frame = imageFrame(node, asset)
  return applyDraft(node, asset, { id: node.id, frame, box: frame })
}

/** Whether a crop lies inside an image of that size and has an area. */
export function isValidCrop(crop: CropRect, asset: Size): boolean {
  const eps = 1e-6
  return (
    [crop.x, crop.y, crop.width, crop.height].every(Number.isFinite) &&
    crop.width > 0 &&
    crop.height > 0 &&
    crop.x >= -eps &&
    crop.y >= -eps &&
    crop.x + crop.width <= asset.width + eps &&
    crop.y + crop.height <= asset.height + eps
  )
}
