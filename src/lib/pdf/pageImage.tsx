import type Konva from 'konva'
import type { ReactNode } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { Group, Layer, Rect, Stage } from 'react-konva'
import { NodeView } from '../../components/NodeView'
import { IDENTITY_TRANSFORM, type Doc, type NodeId, type Page, type VectorNode } from '../../types'
import { exportPixelRatio } from '../exportPng'
import { nodeBounds } from '../geometry/bounds'
import { absoluteTransform } from '../geometry/transform'
import { assetCache } from '../images/assets'
import { pageKonvaFill } from '../paint/toKonva'
import type { NodeImage } from '../svg/exportSvg'
import { IMAGE_MODE_RATIO } from './pdfPages'

const JPEG_QUALITY = 0.92

/** The visible images' assets on the page. */
function shownAssets(doc: Doc, page: Page): string[] {
  const out: string[] = []
  const visit = (id: NodeId) => {
    const node = doc.nodes[id]
    if (!node || node.hidden) return
    if (node.type === 'image') out.push(node.assetId)
    else if (node.type === 'group') node.childIds.forEach(visit)
  }
  page.rootIds.forEach(visit)
  return out
}

interface OffscreenOptions {
  width: number
  height: number
  pixelRatio: number
  mimeType: 'image/jpeg' | 'image/png'
}

/**
 * What `children` draw on a Konva stage of the given size, as a data URL. The stage lives in a
 * React root of its own, off the page, and is gone again when this returns; it draws as it
 * exports, so no frame is needed.
 */
function drawOffscreen(
  children: ReactNode,
  { width, height, pixelRatio, mimeType }: OffscreenOptions,
) {
  const root = createRoot(document.createElement('div'))
  let stage: Konva.Stage | null = null
  const keep = (s: Konva.Stage | null) => {
    stage = s ?? stage
  }
  try {
    flushSync(() =>
      root.render(
        <Stage ref={keep} width={width} height={height} listening={false}>
          <Layer listening={false}>{children}</Layer>
        </Stage>,
      ),
    )
    if (!stage) throw new Error("The page couldn't be drawn.")
    return (stage as Konva.Stage).toDataURL({
      x: 0,
      y: 0,
      width,
      height,
      pixelRatio,
      mimeType,
      quality: JPEG_QUALITY,
    })
  } finally {
    root.unmount()
  }
}

/**
 * The page as a JPEG data URL at 300 dpi (less for a page too large for a browser's canvas),
 * drawn with the canvas's own NodeViews on white paper: a JPEG has no see-through pixels, and a
 * PDF page is white where the background lets it show. It waits for the page's images first, so
 * none is a gray box.
 */
export async function pageJpeg(doc: Doc, page: Page): Promise<string> {
  await assetCache.whenSettled(shownAssets(doc, page))
  const { width, height } = page
  return drawOffscreen(
    <>
      <Rect width={width} height={height} fill="#ffffff" />
      <Rect width={width} height={height} {...pageKonvaFill(page)} />
      {page.rootIds.map((id) => {
        const node = doc.nodes[id]
        return node ? <NodeView key={id} node={node} /> : null
      })}
    </>,
    {
      width,
      height,
      pixelRatio: exportPixelRatio(width, height, IMAGE_MODE_RATIO),
      mimeType: 'image/jpeg',
    },
  )
}

/**
 * A see-through PNG of one node as the canvas draws it, in its own coordinates and without its
 * opacity, which the SVG gives the picture instead: for what svg2pdf.js can't draw. It is drawn
 * at 300 dpi of the page, allowing for the scale the node is shown at; null for a node with no
 * area. Not for groups or images.
 */
export function nodePicture(doc: Doc, node: VectorNode): NodeImage | null {
  const local = { ...node, transform: IDENTITY_TRANSFORM, style: { ...node.style, opacity: 1 } }
  const box = nodeBounds(local, doc.nodes)
  if (!box) return null
  // A text's glyphs may reach past its box (an italic's overhang); antialiasing does too.
  const pad = node.type === 'text' ? node.fontSize * 0.25 : 1
  const x = Math.floor(box.minX - pad)
  const y = Math.floor(box.minY - pad)
  const width = Math.ceil(box.maxX + pad) - x
  const height = Math.ceil(box.maxY + pad) - y
  if (!(width > 0 && height > 0)) return null
  const { scaleX, scaleY } = absoluteTransform(doc.nodes, node.id)
  const scale = Math.max(Math.abs(scaleX), Math.abs(scaleY), 0.01)
  const href = drawOffscreen(
    <Group x={-x} y={-y}>
      <NodeView node={local} />
    </Group>,
    {
      width,
      height,
      pixelRatio: exportPixelRatio(width * scale, height * scale, IMAGE_MODE_RATIO) * scale,
      mimeType: 'image/png',
    },
  )
  return { href, x, y, width, height }
}
