import type { ImageMime } from '../../types'
import { sha256Hex } from './hash'

/** The longest side an imported image keeps; larger ones are scaled down to it. */
export const MAX_IMAGE_SIDE = 4096
/** The quality a scaled-down photo is saved at. */
export const JPEG_QUALITY = 0.9

/** An image ready to be an asset: its bytes as stored, their type, size and SHA-256. */
export interface PreparedImage {
  bytes: Uint8Array
  mime: ImageMime
  width: number
  height: number
  hash: string
}

/** A problem with an image that the user should hear about, in words for a toast. */
export class ImageError extends Error {}

/** The image type the bytes start with: PNG, JPEG or WebP; null for anything else. */
export function sniffMime(bytes: Uint8Array): ImageMime | null {
  const starts = (signature: number[], at = 0) => signature.every((b, i) => bytes[at + i] === b)
  if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png'
  if (starts([0xff, 0xd8, 0xff])) return 'image/jpeg'
  // RIFF....WEBP
  if (starts([0x52, 0x49, 0x46, 0x46]) && starts([0x57, 0x45, 0x42, 0x50], 8)) return 'image/webp'
  return null
}

/**
 * A JPEG's EXIF orientation, 1 to 8; 1 (as stored) when it has none. Phones often store photos
 * on their side with orientation 6 or 8, which viewers turn upright.
 */
export function jpegOrientation(bytes: Uint8Array): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let at = 2
  while (at + 4 <= bytes.length && bytes[at] === 0xff) {
    const marker = bytes[at + 1]
    // Start of scan: the image data follows, and no more metadata.
    if (marker === 0xda) break
    const length = view.getUint16(at + 2)
    // APP1 holding "Exif\0\0", then a TIFF header.
    if (marker === 0xe1 && at + 10 <= bytes.length && view.getUint32(at + 4) === 0x45786966) {
      const tiff = at + 10
      if (tiff + 8 > bytes.length) return 1
      const little = view.getUint16(tiff) === 0x4949
      const u16 = (offset: number) => view.getUint16(offset, little)
      const ifd = tiff + view.getUint32(tiff + 4, little)
      if (ifd + 2 > bytes.length) return 1
      const entries = u16(ifd)
      for (let i = 0; i < entries; i++) {
        const entry = ifd + 2 + i * 12
        if (entry + 12 > bytes.length) return 1
        if (u16(entry) === 0x0112) {
          const orientation = u16(entry + 8)
          return orientation >= 1 && orientation <= 8 ? orientation : 1
        }
      }
      return 1
    }
    at += 2 + length
  }
  return 1
}

/** The size scaled down, keeping its ratio, so its longer side is at most `max`. */
export function fitWithin(
  width: number,
  height: number,
  max = MAX_IMAGE_SIDE,
): { width: number; height: number } {
  const scale = Math.min(1, max / Math.max(width, height))
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  }
}

/** Whether any pixel of RGBA data is less than opaque. */
export function hasTransparency(data: ArrayLike<number>): boolean {
  for (let i = 3; i < data.length; i += 4) if (data[i] < 255) return true
  return false
}

type Context2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D

/** A decoded image, upright, that can be drawn and then let go of. */
export interface Decoded {
  width: number
  height: number
  source: CanvasImageSource
  close(): void
}

/** A canvas to draw a re-encoded image on. */
export interface DrawingSurface {
  context: Context2D
  encode(mime: ImageMime, quality: number): Promise<Blob>
}

/** What preparing an image needs from where it runs: in a worker, or on the page. */
export interface ImageEnvironment {
  decode(blob: Blob): Promise<Decoded>
  surface(width: number, height: number): DrawingSurface
}

/**
 * Makes an image file ready to be an asset. PNG, JPEG and WebP are taken by their bytes, whatever
 * the file claims. An image whose longer side is over MAX_IMAGE_SIDE is scaled down and saved
 * again: as PNG when it has see-through pixels, else as a JPEG at JPEG_QUALITY. So is a JPEG
 * stored on its side, drawn upright, so every viewer of the asset sees it the same way round.
 * Other images keep their bytes. The hash is of the bytes kept.
 */
export async function prepareImage(blob: Blob, env: ImageEnvironment): Promise<PreparedImage> {
  const original = new Uint8Array(await blob.arrayBuffer())
  const mime = sniffMime(original)
  if (!mime) throw new ImageError("isn't a PNG, JPEG or WebP image")
  let decoded: Decoded
  try {
    decoded = await env.decode(new Blob([original as Uint8Array<ArrayBuffer>], { type: mime }))
  } catch {
    throw new ImageError("couldn't be read as an image")
  }
  try {
    const { width, height } = decoded
    if (!(width > 0 && height > 0)) throw new ImageError("couldn't be read as an image")
    const upright = mime !== 'image/jpeg' || jpegOrientation(original) === 1
    if (Math.max(width, height) <= MAX_IMAGE_SIDE && upright) {
      return { bytes: original, mime, width, height, hash: await sha256Hex(original) }
    }
    const size = fitWithin(width, height)
    const surface = env.surface(size.width, size.height)
    const { context } = surface
    context.imageSmoothingEnabled = true
    context.imageSmoothingQuality = 'high'
    context.drawImage(decoded.source, 0, 0, size.width, size.height)
    // A JPEG has no transparency to keep.
    const transparent =
      mime !== 'image/jpeg' &&
      hasTransparency(context.getImageData(0, 0, size.width, size.height).data)
    const out = transparent ? 'image/png' : 'image/jpeg'
    const bytes = new Uint8Array(await (await surface.encode(out, JPEG_QUALITY)).arrayBuffer())
    return { bytes, mime: out, ...size, hash: await sha256Hex(bytes) }
  } finally {
    decoded.close()
  }
}

/** Decodes with createImageBitmap, turned upright by the image's own orientation. */
export async function decodeBitmap(blob: Blob): Promise<Decoded> {
  const bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' })
  return {
    width: bitmap.width,
    height: bitmap.height,
    source: bitmap,
    close: () => bitmap.close(),
  }
}

/** A drawing surface on an OffscreenCanvas, as a worker has; throws where it has no 2D context. */
export function offscreenSurface(width: number, height: number): DrawingSurface {
  const canvas = new OffscreenCanvas(width, height)
  const context = canvas.getContext('2d')
  if (!context) throw new Error('No 2D context on an OffscreenCanvas')
  return { context, encode: (type, quality) => canvas.convertToBlob({ type, quality }) }
}
