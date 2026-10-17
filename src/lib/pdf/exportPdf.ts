import { jsPDF } from 'jspdf'
import { svg2pdf } from 'svg2pdf.js'
import type { Doc, Page } from '../../types'
import { imageDataUrls } from '../fileActions'
import { pageById } from '../pages'
import { exportSvg } from '../svg/exportSvg'
import { nodePicture, pageJpeg } from './pageImage'
import {
  EMBEDDED_FAMILY,
  EMBEDDED_FILES,
  pageFonts,
  pdfFontOf,
  type PdfFontStyle,
} from './pdfFonts'
import { pdfPageSize, type PdfPageSize } from './pdfPages'
import { needsPicture, overWhite } from './pdfPaint'

export type PdfMode = 'vector' | 'image'

export interface PdfExportOptions {
  pageIds: string[] // the pages to export, in their order in the PDF
  mode: PdfMode
  onProgress?(done: number, total: number): void
  signal?: AbortSignal // checked before each page
}

export interface PdfExport {
  bytes: Uint8Array
  notes: string[] // what the PDF shows differently, for a toast
}

// The embedded font's files as base64, kept once fetched.
const fontData = new Map<PdfFontStyle, Promise<string>>()

function base64Of(bytes: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}

/** The embedded font's file for a style, as base64, fetched from public/fonts/ on first use. */
function embeddedFont(style: PdfFontStyle): Promise<string> {
  let data = fontData.get(style)
  if (!data) {
    data = fetch(`${import.meta.env.BASE_URL}fonts/${EMBEDDED_FILES[style]}`).then(
      async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        return base64Of(new Uint8Array(await response.arrayBuffer()))
      },
    )
    // A failed fetch is tried again by the next export.
    data.catch(() => fontData.delete(style))
    fontData.set(style, data)
  }
  return data
}

/**
 * Adds the embedded font's styles to the PDF; false when one couldn't be fetched, so its text
 * falls back to Times.
 */
async function addEmbeddedFonts(pdf: jsPDF, styles: Set<PdfFontStyle>): Promise<boolean> {
  try {
    const files = await Promise.all(
      [...styles].map(async (s) => [s, await embeddedFont(s)] as const),
    )
    for (const [style, base64] of files) {
      pdf.addFileToVFS(EMBEDDED_FILES[style], base64)
      pdf.addFont(EMBEDDED_FILES[style], EMBEDDED_FAMILY, style, undefined, 'Identity-H')
    }
    return true
  } catch {
    return false
  }
}

/**
 * The page as vectors: its SVG export, images inside as data: URLs, each text in its PDF font
 * and pictures of what svg2pdf.js can't draw (needsPicture), drawn by svg2pdf.js at the page's
 * size in points. svg2pdf.js keeps gradients and markers by id for the whole PDF, so each page's
 * ids get its own prefix.
 */
async function drawVectorPage(
  pdf: jsPDF,
  doc: Doc,
  page: Page,
  index: number,
  size: PdfPageSize,
  embedded: boolean,
): Promise<void> {
  const urls = await imageDataUrls(doc, page.id)
  const background = overWhite(page.background)
  const onPaper =
    background === page.background
      ? doc
      : { ...doc, pages: doc.pages.map((p) => (p === page ? { ...page, background } : p)) }
  const svg = exportSvg(onPaper, page.id, {
    imageHref: (asset) => urls.get(asset.id) ?? null,
    fontFamily: (stack) => {
      const { family } = pdfFontOf(stack)
      return family === EMBEDDED_FAMILY && !embedded ? 'times' : family
    },
    idPrefix: `page${index + 1}-`,
    nodeImage: (node) => (needsPicture(node) ? nodePicture(doc, node) : null),
    outlineApart: true,
  })
  const element = new DOMParser().parseFromString(svg, 'image/svg+xml').documentElement
  await svg2pdf(element, pdf, { x: 0, y: 0, width: size.width, height: size.height })
}

/** The page as one JPEG at 300 dpi, drawn as the canvas draws it. */
async function drawImagePage(pdf: jsPDF, doc: Doc, page: Page, size: PdfPageSize): Promise<void> {
  const jpeg = await pageJpeg(doc, page)
  pdf.addImage(jpeg, 'JPEG', 0, 0, size.width, size.height)
}

/**
 * The pages as a PDF, each at its own size (CSS px × 0.75 = pt). Vector mode draws them as
 * vectors with selectable text, except pages whose text the PDF's fonts can't show, which are
 * drawn as images; image mode draws every page as an image.
 */
export async function exportPdf(
  doc: Doc,
  { pageIds, mode, onProgress, signal }: PdfExportOptions,
): Promise<PdfExport> {
  const pages = pageIds.map((id) => pageById(doc, id)).filter((page) => page !== undefined)
  if (pages.length === 0) throw new Error('There are no pages to export.')
  const fonts = new Map(pages.map((page) => [page.id, pageFonts(doc, page.id)]))
  const asImage = (page: Page) => mode === 'image' || fonts.get(page.id)!.needsImage

  const first = pdfPageSize(pages[0])
  const pdf = new jsPDF({
    unit: 'pt',
    format: [first.width, first.height],
    orientation: first.orientation,
    compress: true,
  })
  pdf.setProperties({ title: 'Drawing', creator: 'Simple Painter' })

  const styles = new Set<PdfFontStyle>()
  for (const page of pages) {
    if (!asImage(page)) fonts.get(page.id)!.embedded.forEach((style) => styles.add(style))
  }
  const embedded = styles.size === 0 || (await addEmbeddedFonts(pdf, styles))

  for (const [i, page] of pages.entries()) {
    signal?.throwIfAborted()
    const size = pdfPageSize(page)
    if (i > 0) pdf.addPage([size.width, size.height], size.orientation)
    if (asImage(page)) await drawImagePage(pdf, doc, page, size)
    else await drawVectorPage(pdf, doc, page, i, size, embedded)
    onProgress?.(i + 1, pages.length)
  }
  signal?.throwIfAborted()

  const notes: string[] = []
  if (!embedded) notes.push("Georgia shows in Times: its PDF font couldn't be loaded.")
  return { bytes: new Uint8Array(pdf.output('arraybuffer')), notes }
}
