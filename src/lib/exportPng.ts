import type Konva from 'konva'
import { CANVAS_HEIGHT, CANVAS_WIDTH } from '../types'

export const OVERLAY_LAYER_NAME = 'overlay-layer'
export const EXPORT_FILE_NAME = 'painting.png'
const EXPORT_SCALE = 2 // 1600 × 1000 artboard → 3200 × 2000 PNG

/**
 * Downloads the artboard as a PNG at twice its size, without the overlay. The Stage is briefly
 * reset to scale 1 at position 0, so the result is the same at any zoom and pan.
 */
export function exportPng(stage: Konva.Stage): void {
  const overlay = stage.findOne<Konva.Layer>(`.${OVERLAY_LAYER_NAME}`)
  const overlayWasVisible = overlay?.visible() ?? false
  const scale = stage.scale()
  const position = stage.position()
  overlay?.visible(false)
  stage.scale({ x: 1, y: 1 })
  stage.position({ x: 0, y: 0 })
  try {
    const dataUrl = stage.toDataURL({
      x: 0,
      y: 0,
      width: CANVAS_WIDTH,
      height: CANVAS_HEIGHT,
      pixelRatio: EXPORT_SCALE,
    })
    downloadDataUrl(dataUrl, EXPORT_FILE_NAME)
  } finally {
    stage.scale(scale)
    stage.position(position)
    overlay?.visible(overlayWasVisible)
  }
}

function downloadDataUrl(url: string, fileName: string): void {
  const link = document.createElement('a')
  link.href = url
  link.download = fileName
  document.body.appendChild(link)
  link.click()
  link.remove()
}
