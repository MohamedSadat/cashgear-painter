import { currentPageOf, useEditorStore } from '../store/editorStore'
import { settleTool } from '../tools'
import type { AssetId, Doc } from '../types'
import { chooseFile, downloadBytes, downloadText } from './files'
import { withoutUnusedAssets } from './images/assetRefs'
import { askToPersistStorage, assetCache } from './images/assets'
import { pageSubtree } from './pages'
import type { OpenedAsset } from './painterFile'
import type { PdfExportOptions } from './pdf/exportPdf'
import { PDF_FILE_NAME } from './pdf/pdfPages'
import { parseDocFile, saveAsset } from './persistence'
import { SVG_FILE_NAME, exportSvg } from './svg/exportSvg'
import { importSvg } from './svg/importSvg'

const store = () => useEditorStore.getState()

// The .painter zip code and fflate, loaded on the first save or open.
const loadPainterFile = () => import('./painterFile')
// The PDF export with jsPDF and svg2pdf.js, loaded on the first PDF export.
const loadPdf = () => import('./pdf/exportPdf')

const errorMessage = (error: unknown, fallback: string) =>
  error instanceof Error && error.message ? error.message : fallback

export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

// Said when IndexedDB can't take an image: it shows now, but a refresh loses it.
export const NOT_STORED =
  "The browser couldn't store the image, so a refresh would lose it. Save the drawing to keep it."

/**
 * Downloads the drawing as drawing.painter: a zip of the doc and the images it shows (see
 * buildPainterFile). An image whose bytes can't be found is left out, and a toast says so.
 */
export async function saveDrawing(): Promise<void> {
  settleTool()
  const { doc } = store()
  const bytes = new Map<AssetId, Uint8Array>()
  for (const id of Object.keys(withoutUnusedAssets(doc).assets)) {
    const blob = await assetCache.blob(id)
    if (blob) bytes.set(id, new Uint8Array(await blob.arrayBuffer()))
  }
  const { PAINTER_FILE_NAME, buildPainterFile } = await loadPainterFile()
  const { file, missing } = buildPainterFile(doc, bytes)
  downloadBytes(file, PAINTER_FILE_NAME, 'application/octet-stream')
  if (missing.length > 0) {
    store().showToast(
      `${plural(missing.length, 'image')} couldn't be found, so the file shows gray boxes in their place.`,
    )
  }
}

/** The opened images' bytes, stored and handed to the asset cache; false when storing failed. */
async function keepOpenedAssets(assets: OpenedAsset[]): Promise<boolean> {
  const blobs = assets.map(({ id, mime, bytes }) => ({
    id,
    blob: new Blob([bytes as Uint8Array<ArrayBuffer>], { type: mime }),
  }))
  let stored = true
  for (const { id, blob } of blobs) if (!(await saveAsset(id, blob))) stored = false
  if (blobs.length > 0) askToPersistStorage()
  for (const { id, blob } of blobs) assetCache.put(id, blob)
  return stored
}

/**
 * Opens a .painter file, or a .painter.json one from before images, in place of the drawing, as
 * one undo step, so Undo brings the previous drawing back. A file that isn't a drawing, or comes
 * from an unknown version, changes nothing and says so in a toast.
 */
export async function openDrawing(): Promise<void> {
  const file = await chooseFile('.painter,.json,application/json,application/zip')
  if (!file) return
  try {
    const bytes = new Uint8Array(await file.arrayBuffer())
    let doc: Doc
    let assets: OpenedAsset[] = []
    let missing = 0
    // A zip, as a .painter file is ("PK"); a .painter.json file is text.
    const zip = bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 3 && bytes[3] === 4
    if (zip) ({ doc, assets, missing } = await (await loadPainterFile()).readPainterFile(bytes))
    else doc = parseDocFile(new TextDecoder().decode(bytes))
    const stored = await keepOpenedAssets(assets)
    settleTool()
    store().replaceDoc(doc)
    const notes: string[] = []
    if (missing > 0) {
      notes.push(`${plural(missing, 'image')} in the file couldn't be read and show as gray boxes.`)
    }
    if (!stored) notes.push(NOT_STORED)
    if (notes.length > 0) store().showToast(notes.join(' '))
  } catch (error) {
    store().showToast(errorMessage(error, "The file couldn't be opened."))
  }
}

/** A blob as a data: URL. */
function dataUrlOf(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })
}

/** The page's images as data: URLs by asset id, for an SVG file; images without bytes are left out. */
export async function imageDataUrls(doc: Doc, pageId: string): Promise<Map<AssetId, string>> {
  const urls = new Map<AssetId, string>()
  for (const node of pageSubtree(doc, pageId)) {
    if (node.type !== 'image' || urls.has(node.assetId)) continue
    const blob = await assetCache.blob(node.assetId)
    if (blob) urls.set(node.assetId, await dataUrlOf(blob))
  }
  return urls
}

/**
 * Downloads the current page as drawing.svg, at the page's size, with its images inside as
 * base64 data: URLs.
 */
export async function exportSvgFile(): Promise<void> {
  settleTool()
  const state = store()
  const pageId = currentPageOf(state).id
  const urls = await imageDataUrls(state.doc, pageId)
  const svg = exportSvg(state.doc, pageId, { imageHref: (asset) => urls.get(asset.id) ?? null })
  downloadText(svg, SVG_FILE_NAME, 'image/svg+xml')
}

/**
 * Downloads the chosen pages as drawing.pdf (see exportPdf), loading the PDF code first. Errors,
 * and an abort through `signal`, reach the caller, the export dialog; what the PDF shows
 * differently goes in a toast.
 */
export async function exportPdfFile(options: PdfExportOptions): Promise<void> {
  settleTool()
  const { exportPdf } = await loadPdf()
  const { bytes, notes } = await exportPdf(store().doc, options)
  downloadBytes(bytes, PDF_FILE_NAME, 'application/pdf')
  if (notes.length > 0) store().showToast(notes.join(' '))
}

/**
 * Adds an SVG file's shapes to the current page as one group on top, one undo step, named after
 * the file. The group is selected and the select tool takes over, as after drawing a shape. A
 * toast says how many elements were skipped.
 */
export async function importSvgFromFile(file: File): Promise<void> {
  try {
    const name = file.name.replace(/\.svg$/i, '') || 'Imported SVG'
    const page = currentPageOf(store())
    const { nodes, groupId, skipped } = importSvg(await file.text(), name, page)
    const unsupported = `Skipped ${plural(skipped, 'unsupported element')} (text, images, gradients and the like).`
    if (!groupId) {
      store().showToast(skipped > 0 ? `Nothing to import. ${unsupported}` : 'Nothing to import.')
      return
    }
    settleTool()
    const { addNodes, select, setTool, showToast } = store()
    addNodes(nodes)
    setTool('select')
    select([groupId])
    if (skipped > 0) showToast(`Imported ${name}. ${unsupported}`)
  } catch (error) {
    store().showToast(errorMessage(error, "The SVG couldn't be imported."))
  }
}

/** Lets the user pick an SVG file and imports it (see importSvgFromFile). */
export async function importSvgFile(): Promise<void> {
  const file = await chooseFile('.svg,image/svg+xml')
  if (file) await importSvgFromFile(file)
}
