// Decodes, scales down, saves again and hashes an imported image off the main thread, so a large
// photo doesn't freeze the editor. See prepareImage.
import {
  ImageError,
  decodeBitmap,
  offscreenSurface,
  prepareImage,
  type PreparedImage,
} from './prepare'

export interface PrepareRequest {
  id: number
  blob: Blob
}

export type PrepareResponse =
  | { id: number; ok: true; image: PreparedImage }
  // `unsupported`: this worker can't do it (no OffscreenCanvas 2D context, say); the page can.
  | { id: number; ok: false; message: string; unsupported: boolean }

// The DOM typings describe a window; a worker posts with a transfer list.
const scope = self as unknown as {
  onmessage: ((e: MessageEvent<PrepareRequest>) => void) | null
  postMessage(message: PrepareResponse, transfer?: Transferable[]): void
}

scope.onmessage = async ({ data: { id, blob } }) => {
  try {
    const image = await prepareImage(blob, { decode: decodeBitmap, surface: offscreenSurface })
    scope.postMessage({ id, ok: true, image }, [image.bytes.buffer as ArrayBuffer])
  } catch (error) {
    const known = error instanceof ImageError
    scope.postMessage({
      id,
      ok: false,
      message: known ? error.message : String(error),
      unsupported: !known,
    })
  }
}
