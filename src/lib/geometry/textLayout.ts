import type { TextNode } from '../../types'

/** Line height as a multiple of the font size, for Konva, the text editor and SVG export. */
export const TEXT_LINE_HEIGHT = 1.2

export interface FontOption {
  label: string
  family: string // a CSS font stack, as Konva, the textarea and SVG take it
}

// Fonts are not embedded in SVG exports, so text offers only fonts every system has or replaces
// with a close match.
export const WEB_SAFE_FONTS: FontOption[] = [
  { label: 'Arial', family: 'Arial, Helvetica, sans-serif' },
  { label: 'Verdana', family: 'Verdana, Geneva, sans-serif' },
  { label: 'Trebuchet MS', family: 'Trebuchet MS, Helvetica, sans-serif' },
  { label: 'Georgia', family: 'Georgia, Times New Roman, serif' },
  { label: 'Times New Roman', family: 'Times New Roman, Times, serif' },
  { label: 'Courier New', family: 'Courier New, Courier, monospace' },
]

/** A font stack with multi-word names quoted, as Konva writes it into the canvas font. */
export function quoteFamilies(family: string): string {
  return family
    .split(',')
    .map((name) => {
      const trimmed = name.trim()
      return trimmed.includes(' ') && !/["']/.test(trimmed) ? `"${trimmed}"` : trimmed
    })
    .join(', ')
}

type FontOf = Pick<TextNode, 'fontStyle' | 'fontSize' | 'fontFamily'>

/** The canvas font Konva draws a text node with. */
export function canvasFont({ fontStyle, fontSize, fontFamily }: FontOf): string {
  return `${fontStyle} normal ${fontSize}px ${quoteFamilies(fontFamily)}`
}

type Measure = (text: string) => number

let context: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null | undefined

function measureContext() {
  if (context !== undefined) return context
  context = null
  try {
    if (typeof OffscreenCanvas !== 'undefined') context = new OffscreenCanvas(1, 1).getContext('2d')
    else if (typeof document !== 'undefined')
      context = document.createElement('canvas').getContext('2d')
  } catch {
    context = null
  }
  return context
}

// Without a canvas (unit tests run in Node), a glyph is this many ems wide.
const FALLBACK_EM = 0.6

/** Measures strings in the node's font, as Konva's text layout does. */
function measureFor(font: FontOf): Measure {
  const ctx = measureContext()
  if (!ctx) return (text) => graphemes(text).length * font.fontSize * FALLBACK_EM
  const spec = canvasFont(font)
  return (text) => {
    ctx.font = spec
    return ctx.measureText(text).width
  }
}

const segmenter =
  typeof Intl !== 'undefined' && Intl.Segmenter
    ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    : null

/** User-perceived characters, so an emoji or an accented letter is never split. */
function graphemes(text: string): string[] {
  return segmenter ? Array.from(segmenter.segment(text), (s) => s.segment) : Array.from(text)
}

const isBreak = (char: string) => char === ' ' || char === '-'

/**
 * Lines of text wrapped at word boundaries to fit `maxWidth`, as Konva's Text wraps them with
 * wrap="word": each line is the longest run that fits, moved back to its last space or dash, with
 * the spaces at the break dropped. A word wider than a line is broken between characters. Like
 * Konva, a paragraph stops where not even one character fits.
 */
export function wrapText(text: string, maxWidth: number, measure: Measure): string[] {
  const lines: string[] = []
  for (const paragraph of text.split('\n')) {
    if (measure(paragraph) <= maxWidth) {
      lines.push(paragraph)
      continue
    }
    const chars = graphemes(paragraph)
    let start = 0
    const slice = (end: number) => chars.slice(start, end).join('')
    while (start < chars.length) {
      // The longest prefix that fits, by binary search.
      let low = start
      let high = chars.length
      while (low < high) {
        const mid = (low + high + 1) >>> 1
        if (measure(slice(mid)) <= maxWidth) low = mid
        else high = mid - 1
      }
      if (low === start) break
      if (low === chars.length) {
        lines.push(slice(low))
        break
      }
      if (!isBreak(chars[low])) {
        let wrapAt = low - 1
        while (wrapAt >= start && !isBreak(chars[wrapAt])) wrapAt--
        if (wrapAt >= start) low = wrapAt + 1
      }
      lines.push(slice(low).trimEnd())
      start = low
      while (start < chars.length && !chars[start].trim()) start++
    }
  }
  return lines
}

const linesCache = new WeakMap<TextNode, string[]>()

/** The node's lines as Konva lays them out in its fixed width. */
export function textLines(node: TextNode): string[] {
  let lines = linesCache.get(node)
  if (!lines) {
    lines = wrapText(node.text, node.width, measureFor(node))
    linesCache.set(node, lines)
  }
  return lines
}

/** Height of the node's text box in its own units: one line height per line. */
export function textHeight(node: TextNode): number {
  return Math.max(1, textLines(node).length) * node.fontSize * TEXT_LINE_HEIGHT
}
