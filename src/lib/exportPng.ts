import type Konva from 'konva'
import type { Page } from '../types'
import { downloadUrl } from './files'

export const OVERLAY_LAYER_NAME = 'overlay-layer'
export const EXPORT_FILE_NAME = 'painting.png'
const EXPORT_SCALE = 2 // a 1600 × 1000 page → a 3200 × 2000 PNG
// iOS Safari's largest canvas, in pixels, and the longest side browsers draw.
const MAX_PIXELS = 16_777_216
const MAX_SIDE = 16_384

/**
 * Pixels per page unit for an image of the page: `scale` (the PNG's 2 by default), or less for a
 * page so large that it would be more than browsers can draw.
 */
export function exportPixelRatio(width: number, height: number, scale = EXPORT_SCALE): number {
  return Math.min(
    scale,
    Math.sqrt(MAX_PIXELS / (width * height)),
    MAX_SIDE / Math.max(width, height),
  )
}

/**
 * Downloads the page as a PNG at twice its size (less for a very large page), without the
 * overlay. The Stage is briefly reset to scale 1 at position 0, so the result is the same at any
 * zoom and pan. Returns the pixel ratio used.
 */
export function exportPng(stage: Konva.Stage, page: Pick<Page, 'width' | 'height'>): number {
  const overlay = stage.findOne<Konva.Layer>(`.${OVERLAY_LAYER_NAME}`)
  const overlayWasVisible = overlay?.visible() ?? false
  const scale = stage.scale()
  const position = stage.position()
  const pixelRatio = exportPixelRatio(page.width, page.height)
  overlay?.visible(false)
  stage.scale({ x: 1, y: 1 })
  stage.position({ x: 0, y: 0 })
  try {
    const dataUrl = stage.toDataURL({
      x: 0,
      y: 0,
      width: page.width,
      height: page.height,
      pixelRatio,
    })
    downloadUrl(dataUrl, EXPORT_FILE_NAME)
  } finally {
    stage.scale(scale)
    stage.position(position)
    overlay?.visible(overlayWasVisible)
  }
  return pixelRatio
}
