import { strFromU8, unzlibSync } from 'fflate'

/** One page of a PDF: its size in points, its content stream and the text a viewer would select. */
export interface PdfPage {
  width: number
  height: number
  content: string
  text: string[] // each shown string, decoded, in drawing order
}

export interface PdfFile {
  pages: PdfPage[]
  objects: string[] // every object's dictionary, for looking for shadings and images
}

interface PdfObject {
  dict: string
  stream: string | null // inflated when FlateDecode, as Latin-1
}

// Windows-1252's characters at 0x80–0x9f, as the built-in fonts' WinAnsiEncoding has them.
const WIN_ANSI: Record<number, string> = {
  0x80: '€',
  0x82: '‚',
  0x83: 'ƒ',
  0x84: '„',
  0x85: '…',
  0x86: '†',
  0x87: '‡',
  0x88: 'ˆ',
  0x89: '‰',
  0x8a: 'Š',
  0x8b: '‹',
  0x8c: 'Œ',
  0x8e: 'Ž',
  0x91: '‘',
  0x92: '’',
  0x93: '“',
  0x94: '”',
  0x95: '•',
  0x96: '–',
  0x97: '—',
  0x98: '˜',
  0x99: '™',
  0x9a: 'š',
  0x9b: '›',
  0x9c: 'œ',
  0x9e: 'ž',
  0x9f: 'Ÿ',
}

/** The objects of a PDF as jsPDF writes it: "n 0 obj … endobj", streams after their dictionary. */
function readObjects(bytes: Uint8Array): Map<number, PdfObject> {
  const text = Buffer.from(bytes).toString('latin1')
  const objects = new Map<number, PdfObject>()
  for (const match of text.matchAll(/(\d+) 0 obj\s*([\s\S]*?)endobj/g)) {
    const body = match[2]
    const at = body.search(/stream\r?\n/)
    if (at < 0) {
      objects.set(Number(match[1]), { dict: body, stream: null })
      continue
    }
    const dict = body.slice(0, at)
    const start = body.indexOf('\n', at) + 1
    const end = body.lastIndexOf('endstream')
    const raw = Uint8Array.from(Buffer.from(body.slice(start, end).replace(/\r?\n$/, ''), 'latin1'))
    const stream = /\/FlateDecode/.test(dict)
      ? strFromU8(unzlibSync(raw), true)
      : body.slice(start, end)
    objects.set(Number(match[1]), { dict, stream })
  }
  return objects
}

/** A ToUnicode CMap's codes and the text each stands for. */
function readCmap(cmap: string): Map<number, string> {
  const map = new Map<number, string>()
  const utf16 = (hex: string) =>
    String.fromCharCode(...(hex.match(/.{4}/g) ?? []).map((unit) => parseInt(unit, 16)))
  for (const block of cmap.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const [, code, to] of block[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) {
      map.set(parseInt(code, 16), utf16(to))
    }
  }
  for (const block of cmap.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const [, from, to, first] of block[1].matchAll(
      /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g,
    )) {
      for (let code = parseInt(from, 16), n = 0; code <= parseInt(to, 16); code++, n++) {
        map.set(code, String.fromCharCode(parseInt(first, 16) + n))
      }
    }
  }
  return map
}

/** A literal string's bytes, its escapes undone. */
function literalBytes(body: string): number[] {
  const out: number[] = []
  for (let i = 0; i < body.length; i++) {
    const c = body[i]
    if (c !== '\\') {
      out.push(c.charCodeAt(0))
      continue
    }
    const next = body[++i]
    const octal = /^[0-7]{1,3}/.exec(body.slice(i))
    if (octal) {
      out.push(parseInt(octal[0], 8))
      i += octal[0].length - 1
    } else {
      const escapes: Record<string, number> = { n: 10, r: 13, t: 9, b: 8, f: 12 }
      out.push(escapes[next] ?? next.charCodeAt(0))
    }
  }
  return out
}

/**
 * Reads what a test needs from a PDF that jsPDF wrote: each page's size and content, and the text
 * shown with Tj, decoded as a viewer decodes it for selecting and searching: built-in fonts
 * through WinAnsiEncoding, embedded fonts through their ToUnicode CMap.
 */
export function readPdf(bytes: Uint8Array): PdfFile {
  const objects = readObjects(bytes)
  const ref = (dict: string, key: string) => {
    const match = new RegExp(`/${key} (\\d+) 0 R`).exec(dict)
    return match ? objects.get(Number(match[1])) : undefined
  }

  // Font resource names (/F15) to their ToUnicode maps; built-in fonts have none.
  const cmaps = new Map<string, Map<number, string>>()
  for (const { dict } of objects.values()) {
    const fonts = /\/Font\s*<<([\s\S]*?)>>/.exec(dict)
    if (!fonts) continue
    for (const [, name, num] of fonts[1].matchAll(/\/(\w+) (\d+) 0 R/g)) {
      const font = objects.get(Number(num))
      const toUnicode = font && ref(font.dict, 'ToUnicode')
      if (toUnicode?.stream) cmaps.set(name, readCmap(toUnicode.stream))
    }
  }

  // The pages in their order: the page tree's kids.
  const tree = [...objects.values()].find(({ dict }) => /\/Type\s*\/Pages\b/.test(dict))!
  const kids = /\/Kids\s*\[([^\]]*)\]/.exec(tree.dict)![1]
  const pages: PdfPage[] = []
  for (const [, num] of kids.matchAll(/(\d+) 0 R/g)) {
    const { dict } = objects.get(Number(num))!
    const box = /\/MediaBox\s*\[([^\]]+)\]/.exec(dict)![1].trim().split(/\s+/).map(Number)
    const content = ref(dict, 'Contents')?.stream ?? ''
    const text: string[] = []
    let cmap: Map<number, string> | undefined
    const tokens = /\/(\w+)\s+[\d.]+\s+Tf|\(((?:\\.|[^\\)])*)\)\s*Tj|<([0-9a-fA-F]*)>\s*Tj/g
    for (const [, font, literal, hex] of content.matchAll(tokens)) {
      if (font !== undefined) cmap = cmaps.get(font)
      else if (literal !== undefined) {
        text.push(
          literalBytes(literal)
            .map((b) => WIN_ANSI[b] ?? String.fromCharCode(b))
            .join(''),
        )
      } else if (hex !== undefined && cmap) {
        const codes = (hex.match(/.{4}/g) ?? []).map((code) => parseInt(code, 16))
        text.push(codes.map((code) => cmap!.get(code) ?? '�').join(''))
      }
    }
    pages.push({ width: box[2] - box[0], height: box[3] - box[1], content, text })
  }
  return { pages, objects: [...objects.values()].map((o) => o.dict) }
}
