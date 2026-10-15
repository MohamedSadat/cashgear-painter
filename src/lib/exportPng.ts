import type Konva from 'konva'

export const CURSOR_LAYER_NAME = 'cursor-layer'
export const EXPORT_FILE_NAME = 'painting.png'
const EXPORT_SCALE = 2 // 1600 × 1000 canvas → 3200 × 2000 PNG

/** Downloads the Stage as a PNG at twice the canvas size, without the brush cursor. */
export function exportPng(stage: Konva.Stage): void {
  const scale = stage.scaleX()
  const cursorLayer = stage.findOne<Konva.Layer>(`.${CURSOR_LAYER_NAME}`)
  const cursorWasVisible = cursorLayer?.visible() ?? false
  cursorLayer?.visible(false)
  try {
    // Konva floors width × pixelRatio, and 1600·scale × 2/scale can land a hair under 3200,
    // so the ratio is nudged up by a millionth.
    const dataUrl = stage.toDataURL({ pixelRatio: (EXPORT_SCALE / scale) * (1 + 1e-6) })
    downloadDataUrl(dataUrl, EXPORT_FILE_NAME)
  } finally {
    cursorLayer?.visible(cursorWasVisible)
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
