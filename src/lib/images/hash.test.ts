import { afterEach, describe, expect, it, vi } from 'vitest'
import { sha256Hex, sha256Js } from './hash'

const text = (s: string) => new TextEncoder().encode(s)
// Node's Web Crypto, as the reference.
const subtle = globalThis.crypto.subtle
async function nodeHash(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>))
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('')
}

describe('sha256Js', () => {
  it('matches the FIPS 180-4 examples', () => {
    expect(sha256Js(text(''))).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    )
    expect(sha256Js(text('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    )
    expect(sha256Js(text('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'))).toBe(
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    )
  })

  it("agrees with Node's Web Crypto at every padding length and on a megabyte", async () => {
    // Lengths around the 56- and 64-byte block edges, where the padding spills into a new block.
    for (let length = 0; length <= 200; length++) {
      const bytes = Uint8Array.from({ length }, (_, i) => (i * 31 + length) & 0xff)
      expect(sha256Js(bytes)).toBe(await nodeHash(bytes))
    }
    const big = Uint8Array.from({ length: 1 << 20 }, (_, i) => (i * 2654435761) >>> 24)
    expect(sha256Js(big)).toBe(await nodeHash(big))
  })
})

describe('sha256Hex', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('uses crypto.subtle when there is one', async () => {
    const bytes = text('a picture')
    const expected = await nodeHash(bytes)
    const digest = vi.spyOn(globalThis.crypto.subtle, 'digest')
    expect(await sha256Hex(bytes)).toBe(expected)
    expect(digest).toHaveBeenCalledOnce()
    digest.mockRestore()
  })

  it('falls back to plain JavaScript without crypto.subtle, as on plain-http LAN URLs', async () => {
    const bytes = text('a picture')
    const expected = await nodeHash(bytes)
    vi.stubGlobal('crypto', {})
    expect(await sha256Hex(bytes)).toBe(expected)
  })
})
