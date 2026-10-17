import {
  ImageError,
  decodeBitmap,
  prepareImage,
  type Decoded,
  type DrawingSurface,
  type PreparedImage,
} from './prepare'
import type { PrepareRequest, PrepareResponse } from './prepareImage.worker'

let worker: Worker | null | undefined
let nextId = 0
const pending = new Map<number, (response: PrepareResponse) => void>()

/**
 * The worker that prepares images; null where workers or OffscreenCanvas are missing, or the
 * worker failed, and the page does the work itself.
 */
function imageWorker(): Worker | null {
  if (worker !== undefined) return worker
  try {
    if (typeof Worker === 'undefined' || typeof OffscreenCanvas === 'undefined') {
      worker = null
      return worker
    }
    const created = new Worker(new URL('./prepareImage.worker.ts', import.meta.url), {
      type: 'module',
    })
    created.onmessage = ({ data }: MessageEvent<PrepareResponse>) => {
      pending.get(data.id)?.(data)
      pending.delete(data.id)
    }
    // A worker that can't start (no module workers, say) answers every request as unsupported.
    created.onerror = () => {
      worker = null
      for (const [id, reply] of pending) {
        reply({ id, ok: false, message: 'The image worker failed', unsupported: true })
      }
      pending.clear()
    }
    worker = created
  } catch {
    worker = null
  }
  return worker
}

/** Decodes on the page: createImageBitmap where there is one, else an <img>. */
async function decodeOnPage(blob: Blob): Promise<Decoded> {
  if (typeof createImageBitmap === 'function') return decodeBitmap(blob)
  const url = URL.createObjectURL(blob)
  try {
    const image = new Image()
    image.src = url
    await image.decode()
    return { width: image.naturalWidth, height: image.naturalHeight, source: image, close() {} }
  } finally {
    URL.revokeObjectURL(url)
  }
}

function pageSurface(width: number, height: number): DrawingSurface {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d')
  if (!context) throw new Error('No 2D context')
  return {
    context,
    encode: (type, quality) =>
      new Promise((resolve, reject) =>
        canvas.toBlob(
          (blob) => (blob ? resolve(blob) : reject(new Error('Encoding failed'))),
          type,
          quality,
        ),
      ),
  }
}

/** Prepares the image on the page; a slower fallback that holds up the editor while it decodes. */
const prepareOnPage = (blob: Blob) =>
  prepareImage(blob, { decode: decodeOnPage, surface: pageSurface })

/**
 * Makes an image file ready to be an asset (see prepareImage): in a worker, so a large photo
 * doesn't freeze the editor, or on the page where workers can't. Rejects with an ImageError when
 * the file isn't an image the editor takes.
 */
export async function prepareImageFile(blob: Blob): Promise<PreparedImage> {
  const target = imageWorker()
  if (!target) return prepareOnPage(blob)
  const id = (nextId += 1)
  const response = await new Promise<PrepareResponse>((resolve) => {
    pending.set(id, resolve)
    const request: PrepareRequest = { id, blob }
    target.postMessage(request)
  })
  if (response.ok) return response.image
  if (response.unsupported) return prepareOnPage(blob)
  throw new ImageError(response.message)
}
