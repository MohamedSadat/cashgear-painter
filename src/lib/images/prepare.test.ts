import { describe, expect, it, vi } from 'vitest'
import { sha256Js } from './hash'
import {
  ImageError,
  JPEG_QUALITY,
  MAX_IMAGE_SIDE,
  fitWithin,
  hasTransparency,
  jpegOrientation,
  prepareImage,
  sniffMime,
  type ImageEnvironment,
} from './prepare'

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const png = (...rest: number[]) => Uint8Array.from([...PNG_SIGNATURE, ...rest])
const webp = Uint8Array.from([
  ...[0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0],
  ...[0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38],
])

/** A JPEG start with an EXIF block whose orientation is `orientation`, in either byte order. */
function jpeg(orientation: number | null, little = false): Uint8Array<ArrayBuffer> {
  const u16 = (n: number) => (little ? [n & 0xff, n >> 8] : [n >> 8, n & 0xff])
  const u32 = (n: number) =>
    little ? [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, n >>> 24] : [n >>> 24, 0, 0, n & 0xff]
  const entries =
    orientation === null
      ? [...u16(1), ...u16(0x010f), ...u16(2), ...u32(4), ...u32(0)] // Make, not orientation
      : [...u16(1), ...u16(0x0112), ...u16(3), ...u32(1), ...u16(orientation), 0, 0]
  const tiff = [...(little ? [0x49, 0x49] : [0x4d, 0x4d]), ...u16(42), ...u32(8), ...entries]
  const exif = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff]
  const app1 = [0xff, 0xe1, (exif.length + 2) >> 8, (exif.length + 2) & 0xff, ...exif]
  // A JFIF APP0 block first, as cameras often write, then EXIF, then the start of scan.
  const app0 = [0xff, 0xe0, 0, 4, 1, 2]
  return Uint8Array.from([0xff, 0xd8, ...app0, ...app1, 0xff, 0xda, 0, 2])
}

describe('image sniffing', () => {
  it('tells PNG, JPEG and WebP by their bytes', () => {
    expect(sniffMime(png(0))).toBe('image/png')
    expect(sniffMime(jpeg(1))).toBe('image/jpeg')
    expect(sniffMime(webp)).toBe('image/webp')
    expect(sniffMime(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBe(
      null,
    )
    expect(sniffMime(new Uint8Array(0))).toBe(null)
  })

  it("reads a JPEG's EXIF orientation in either byte order", () => {
    expect(jpegOrientation(jpeg(6))).toBe(6)
    expect(jpegOrientation(jpeg(8, true))).toBe(8)
    expect(jpegOrientation(jpeg(null))).toBe(1)
    expect(jpegOrientation(jpeg(42))).toBe(1)
    // Cut short, it is read as stored.
    expect(jpegOrientation(jpeg(6).slice(0, 20))).toBe(1)
  })

  it('fits sizes within the longest side, keeping the ratio', () => {
    expect(fitWithin(8000, 6000)).toEqual({ width: MAX_IMAGE_SIDE, height: 3072 })
    expect(fitWithin(3000, 9000)).toEqual({ width: 1365, height: MAX_IMAGE_SIDE })
    expect(fitWithin(4096, 100)).toEqual({ width: 4096, height: 100 })
    expect(fitWithin(100000, 1)).toEqual({ width: MAX_IMAGE_SIDE, height: 1 })
  })

  it('finds see-through pixels', () => {
    expect(hasTransparency([1, 2, 3, 255, 4, 5, 6, 255])).toBe(false)
    expect(hasTransparency([1, 2, 3, 255, 4, 5, 6, 254])).toBe(true)
  })
})

/**
 * A stand-in for the browser: decoding gives the size asked for, drawing records what was drawn,
 * and encoding gives bytes named after the type and quality.
 */
function environment(width: number, height: number, alpha = 255) {
  const draws: number[][] = []
  const encodes: { type: string; quality: number; size: [number, number] }[] = []
  const closed = vi.fn()
  const getImageData = vi.fn((_x: number, _y: number, w: number, h: number) => ({
    data: new Uint8ClampedArray(w * h * 4).fill(alpha),
  }))
  const env: ImageEnvironment = {
    decode: async () => ({ width, height, source: {} as CanvasImageSource, close: closed }),
    surface: (w, h) => ({
      context: {
        drawImage: (_source: CanvasImageSource, ...args: number[]) => draws.push(args),
        getImageData,
      } as unknown as CanvasRenderingContext2D,
      encode: async (type, quality) => {
        encodes.push({ type, quality, size: [w, h] })
        return new Blob([`${type} ${quality} ${w}x${h}`])
      },
    }),
  }
  return { env, draws, encodes, closed, getImageData }
}

describe('prepareImage', () => {
  it('keeps the bytes of an image small enough, hashed as they are', async () => {
    const bytes = png(1, 2, 3)
    const { env, encodes, closed } = environment(800, 600)

    const image = await prepareImage(new Blob([bytes]), env)

    expect(image).toEqual({
      bytes,
      mime: 'image/png',
      width: 800,
      height: 600,
      hash: sha256Js(bytes),
    })
    expect(encodes).toEqual([])
    expect(closed).toHaveBeenCalledOnce()
  })

  it('scales a large photo down to 4096 px and saves it as a JPEG', async () => {
    const { env, draws, encodes, getImageData } = environment(8000, 6000)

    const image = await prepareImage(new Blob([jpeg(1)]), env)

    expect(draws).toEqual([[0, 0, 4096, 3072]])
    expect(encodes).toEqual([{ type: 'image/jpeg', quality: JPEG_QUALITY, size: [4096, 3072] }])
    // A JPEG has nothing see-through to look for.
    expect(getImageData).not.toHaveBeenCalled()
    expect(image).toMatchObject({ mime: 'image/jpeg', width: 4096, height: 3072 })
    expect(image.hash).toBe(sha256Js(image.bytes))
    expect(new TextDecoder().decode(image.bytes)).toBe('image/jpeg 0.9 4096x3072')
  })

  it('keeps a large image with see-through pixels a PNG, and one without them a JPEG', async () => {
    const clear = environment(5000, 5000, 128)
    expect((await prepareImage(new Blob([png()]), clear.env)).mime).toBe('image/png')
    const opaque = environment(5000, 5000)
    expect((await prepareImage(new Blob([webp]), opaque.env)).mime).toBe('image/jpeg')
  })

  it('draws a photo stored on its side upright, at its size', async () => {
    const { env, draws } = environment(3024, 4032)

    const image = await prepareImage(new Blob([jpeg(6)]), env)

    expect(draws).toEqual([[0, 0, 3024, 4032]])
    expect(image).toMatchObject({ mime: 'image/jpeg', width: 3024, height: 4032 })
  })

  it("refuses files that aren't PNG, JPEG or WebP, or can't be decoded", async () => {
    const { env } = environment(10, 10)
    const svg = new Blob(['<svg xmlns="http://www.w3.org/2000/svg"/>'])
    await expect(prepareImage(svg, env)).rejects.toThrow(ImageError)
    await expect(prepareImage(svg, env)).rejects.toThrow("isn't a PNG, JPEG or WebP image")

    const broken = { ...env, decode: () => Promise.reject(new Error('corrupt')) }
    await expect(prepareImage(new Blob([png()]), broken)).rejects.toThrow(
      "couldn't be read as an image",
    )
  })
})
