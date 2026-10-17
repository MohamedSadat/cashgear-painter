import { pageById } from '../pages'
import type { Doc, NodeId, TextNode } from '../../types'

/** jsPDF's built-in fonts, and the one font the PDF export embeds. */
export type PdfFontFamily = 'helvetica' | 'times' | 'courier' | typeof EMBEDDED_FAMILY

export interface PdfFont {
  family: PdfFontFamily
  // false when the text's own font has no PDF match, so the PDF shows `family` in its place
  mapped: boolean
}

/**
 * Gelasio, an open font with Georgia's metrics, stands in for Georgia: jsPDF has no font like
 * it. Its TTFs are in public/fonts/, fetched on the first export that needs them.
 */
export const EMBEDDED_FAMILY = 'Gelasio'

export type PdfFontStyle = 'normal' | 'bold' | 'italic' | 'bolditalic'

export const EMBEDDED_FILES: Record<PdfFontStyle, string> = {
  normal: 'Gelasio-Regular.ttf',
  bold: 'Gelasio-Bold.ttf',
  italic: 'Gelasio-Italic.ttf',
  bolditalic: 'Gelasio-BoldItalic.ttf',
}

// Fonts with a PDF match by name, each a metric match: Arial is drawn to Helvetica's widths,
// Times New Roman to Times', Courier New to Courier's, Gelasio to Georgia's. The generic
// families go to the built-in font of their kind.
const MATCHES: Record<string, PdfFontFamily> = {
  arial: 'helvetica',
  helvetica: 'helvetica',
  'sans-serif': 'helvetica',
  'times new roman': 'times',
  times: 'times',
  serif: 'times',
  'courier new': 'courier',
  courier: 'courier',
  monospace: 'courier',
  georgia: EMBEDDED_FAMILY,
}

/** The names in a CSS font stack, unquoted, as written. */
function familyNames(stack: string): string[] {
  return stack
    .split(',')
    .map((name) =>
      name
        .trim()
        .replace(/^(["'])(.*)\1$/, '$2')
        .trim(),
    )
    .filter((name) => name !== '')
}

/** The stack's first font, as the warning names it. */
export function firstFamily(stack: string): string {
  return familyNames(stack)[0] ?? stack
}

/**
 * The PDF font for a text's font stack. The first font picks it when it has a match; otherwise
 * the stack's next match (a browser's fallback), or Helvetica, stands in, and `mapped` is false.
 */
export function pdfFontOf(stack: string): PdfFont {
  const names = familyNames(stack).map((name) => name.toLowerCase())
  const first = names.length > 0 ? MATCHES[names[0]] : undefined
  if (first) return { family: first, mapped: true }
  const fallback = names.map((name) => MATCHES[name]).find((family) => family !== undefined)
  return { family: fallback ?? 'helvetica', mapped: false }
}

/** jsPDF's style name for a text's style. */
export function pdfFontStyle(fontStyle: TextNode['fontStyle']): PdfFontStyle {
  const bold = fontStyle.includes('bold')
  const italic = fontStyle.includes('italic')
  return bold && italic ? 'bolditalic' : bold ? 'bold' : italic ? 'italic' : 'normal'
}

// The characters of Windows-1252 above ASCII's printable ones that aren't Latin-1: the built-in
// fonts' WinAnsiEncoding.
const WIN_ANSI_EXTRA = new Set([
  0x20ac, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152,
  0x017d, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a,
  0x0153, 0x017e, 0x0178,
])

/**
 * Whether the PDF's fonts can show every character of the text: those of Windows-1252, which
 * jsPDF's built-in fonts are limited to. Gelasio holds more, but is held to the same set.
 */
export function pdfCanShow(text: string): boolean {
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    const shown =
      (code >= 0x20 && code <= 0x7e) ||
      (code >= 0xa0 && code <= 0xff) ||
      code === 0x09 || // tab, and the line breaks between lines
      code === 0x0a ||
      code === 0x0d ||
      WIN_ANSI_EXTRA.has(code)
    if (!shown) return false
  }
  return true
}

/** The page's text nodes that the export draws: visible, in no hidden group. */
export function visibleTexts(doc: Doc, pageId: string): TextNode[] {
  const out: TextNode[] = []
  const visit = (id: NodeId) => {
    const node = doc.nodes[id]
    if (!node || node.hidden) return
    if (node.type === 'text') out.push(node)
    else if (node.type === 'group') node.childIds.forEach(visit)
  }
  pageById(doc, pageId)?.rootIds.forEach(visit)
  return out
}

/** A font the PDF has no match for, and the PDF font that stands in for it. */
export interface UnmappedFont {
  name: string // the stack's first font
  family: PdfFontFamily
}

export interface PageFonts {
  unmapped: UnmappedFont[] // each once
  embedded: Set<PdfFontStyle> // the embedded font's styles the page's text uses
  // whether some text has characters the PDF's fonts can't show, so the page is drawn as an image
  needsImage: boolean
}

/** What the page's text asks of the PDF's fonts. */
export function pageFonts(doc: Doc, pageId: string): PageFonts {
  const unmapped = new Map<string, UnmappedFont>()
  const embedded = new Set<PdfFontStyle>()
  let needsImage = false
  for (const node of visibleTexts(doc, pageId)) {
    if (node.text.trim() === '') continue
    const font = pdfFontOf(node.fontFamily)
    const name = firstFamily(node.fontFamily)
    if (!font.mapped)
      unmapped.set(
        `${name}
${font.family}`,
        { name, family: font.family },
      )
    if (font.family === EMBEDDED_FAMILY) embedded.add(pdfFontStyle(node.fontStyle))
    if (!pdfCanShow(node.text)) needsImage = true
  }
  return { unmapped: [...unmapped.values()], embedded, needsImage }
}

const FAMILY_NAMES: Record<PdfFontFamily, string> = {
  helvetica: 'Helvetica',
  times: 'Times',
  courier: 'Courier',
  [EMBEDDED_FAMILY]: EMBEDDED_FAMILY,
}

/** Words joined as a sentence lists them: "1", "1 and 3", "1, 2 and 4". */
export function joinWords(words: (string | number)[]): string {
  const all = words.map(String)
  return all.length <= 1 ? (all[0] ?? '') : `${all.slice(0, -1).join(', ')} and ${all.at(-1)}`
}

const pagesOf = (numbers: number[]) =>
  `${numbers.length === 1 ? 'page' : 'pages'} ${joinWords(numbers)}`

/**
 * What a vector PDF of the pages shows differently from the canvas, for the export dialog: fonts
 * it has no match for, and pages drawn as images because their text has characters its fonts
 * can't show. Pages are numbered from 1 in the doc's order.
 */
export function pdfWarnings(doc: Doc, pageIds: string[]): string[] {
  const unmapped = new Map<string, { font: UnmappedFont; pages: number[] }>()
  const images: number[] = []
  for (const id of pageIds) {
    const number = doc.pages.findIndex((page) => page.id === id) + 1
    const fonts = pageFonts(doc, id)
    if (fonts.needsImage) {
      images.push(number)
      continue
    }
    for (const font of fonts.unmapped) {
      const key = `${font.name}
${font.family}`
      const entry = unmapped.get(key) ?? { font, pages: [] }
      entry.pages.push(number)
      unmapped.set(key, entry)
    }
  }
  const warnings = [...unmapped.values()].map(({ font, pages }) => {
    const shows = pages.length === 1 ? 'shows' : 'show'
    return `${font.name} isn't a PDF font, so ${pagesOf(pages)} ${shows} it in ${FAMILY_NAMES[font.family]}.`
  })
  if (images.length > 0) {
    const one = images.length === 1
    const which = pagesOf(images)
    warnings.push(
      `${which[0].toUpperCase()}${which.slice(1)} ${one ? 'has' : 'have'} characters the PDF's fonts can't show, such as Arabic, Chinese or emoji, so ${one ? 'it is' : 'they are'} drawn as ${one ? 'an image' : 'images'}, without selectable text.`,
    )
  }
  return warnings
}
