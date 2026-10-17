import { useEditorStore, type NewImage } from '../store/editorStore'
import { settleTool } from '../tools'
import { finishTextEdit } from '../tools/textTool'
import type { AssetMeta } from '../types'
import { NOT_STORED, importSvgFromFile } from './fileActions'
import { chooseFiles } from './files'
import { askToPersistStorage, assetCache } from './images/assets'
import { ImageError, type PreparedImage } from './images/prepare'
import { prepareImageFile } from './images/prepareClient'
import { saveAsset } from './persistence'

const store = () => useEditorStore.getState()

/** What the picker offers: images, and SVG files, which the SVG importer takes. */
export const IMPORT_ACCEPT =
  'image/png,image/jpeg,image/webp,image/svg+xml,.png,.jpg,.jpeg,.webp,.svg'

// Files this large take a moment, so a toast says the import has begun.
const SLOW_FILE_BYTES = 2_000_000

export const isSvgFile = (file: File) => file.type === 'image/svg+xml' || /\.svg$/i.test(file.name)

/** A layer name from a file name: without its extension. */
const layerName = (fileName: string) => fileName.replace(/\.[^.]*$/, '').trim() || 'Image'

/**
 * Adds image files to the current page as image nodes, in one undo step: centered, scaled down to
 * fit inside 80% of the page, selected, with the select tool taking over. Each is decoded and,
 * when large, scaled down in a worker (prepareImageFile), and stored once by its SHA-256, so the
 * same image imported twice is stored once. Files that aren't images say so in a toast.
 */
export async function importImageFiles(files: File[]): Promise<void> {
  if (files.length === 0) return
  let waiting: number | null = null
  if (files.some((file) => file.size >= SLOW_FILE_BYTES)) {
    store().showToast(
      files.length === 1 ? `Importing ${files[0].name || 'the image'}…` : 'Importing images…',
    )
    waiting = store().toast?.id ?? null
  }

  const prepared: { file: File; image: PreparedImage }[] = []
  const notes: string[] = []
  // One at a time, so several large photos don't all sit in memory at once.
  for (const file of files) {
    try {
      prepared.push({ file, image: await prepareImageFile(file) })
    } catch (error) {
      const why = error instanceof ImageError ? error.message : "couldn't be imported"
      notes.push(`${file.name || 'The image'} ${why}.`)
    }
  }

  const images: (NewImage & { blob: Blob })[] = []
  let stored = true
  for (const { file, image } of prepared) {
    const asset: AssetMeta = store().doc.assets[image.hash] ?? {
      id: image.hash,
      mime: image.mime,
      width: image.width,
      height: image.height,
      bytes: image.bytes.byteLength,
    }
    const blob = new Blob([image.bytes as Uint8Array<ArrayBuffer>], { type: asset.mime })
    // Stored before the doc can show it, so an autosave never points at missing bytes.
    if (!(await saveAsset(asset.id, blob))) stored = false
    images.push({ asset, name: layerName(file.name), blob })
  }

  if (images.length > 0) {
    askToPersistStorage()
    // What is being typed, cropped or drawn ends first, as before a file action.
    finishTextEdit()
    settleTool()
    for (const { asset, blob } of images) assetCache.put(asset.id, blob)
    store().importImages(images.map(({ asset, name }) => ({ asset, name })))
    store().setTool('select')
  }
  if (!stored) notes.push(NOT_STORED)
  if (notes.length > 0) store().showToast(notes.join(' '))
  else if (waiting !== null) store().dismissToast(waiting)
}

/**
 * Imports files dropped or pasted onto the canvas, or picked: PNG, JPEG and WebP as images (see
 * importImageFiles), SVG files through the SVG importer.
 */
export async function importFiles(files: File[]): Promise<void> {
  const images = files.filter((file) => !isSvgFile(file))
  await importImageFiles(images)
  for (const file of files.filter(isSvgFile)) await importSvgFromFile(file)
}

/** Lets the user pick images or SVG files and imports them. */
export async function importImagesFromPicker(): Promise<void> {
  await importFiles(await chooseFiles(IMPORT_ACCEPT, true))
}
