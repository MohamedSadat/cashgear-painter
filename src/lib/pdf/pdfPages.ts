import type { Page } from '../../types'

/** PDF points per CSS pixel: 72 points and 96 pixels make an inch. */
export const PT_PER_PX = 0.75

/** Image mode's pixels per CSS pixel: 300 dpi. */
export const IMAGE_MODE_RATIO = 300 / 96

export const PDF_FILE_NAME = 'drawing.pdf'

export interface PdfPageSize {
  width: number // points
  height: number
  // jsPDF swaps a format's sides to suit its orientation, so every page passes the one it has.
  orientation: 'portrait' | 'landscape'
}

/** A page's size in PDF points, with the orientation jsPDF must be given to keep it. */
export function pdfPageSize({ width, height }: Pick<Page, 'width' | 'height'>): PdfPageSize {
  return {
    width: width * PT_PER_PX,
    height: height * PT_PER_PX,
    orientation: width > height ? 'landscape' : 'portrait',
  }
}

export type PageRange =
  { pages: number[]; error?: undefined } | { pages?: undefined; error: string }

const EXAMPLE = 'such as 1-3, 5'

/**
 * The pages a range like "1-3, 5" names, as indices into the doc's pages, in the doc's order and
 * each once. Items are separated by commas or spaces; a range takes a hyphen or a dash, and may
 * leave out its start ("-3", from the first page) or its end ("4-", to the last).
 */
export function parsePageRange(text: string, count: number): PageRange {
  const items = text
    .replace(/\s*[-–—]\s*/g, '-')
    .split(/[\s,;]+/)
    .filter((item) => item !== '')
  if (items.length === 0) return { error: `Type the pages to export, ${EXAMPLE}.` }
  const picked = new Set<number>()
  for (const item of items) {
    const match = /^(\d*)(-?)(\d*)$/.exec(item)
    if (!match || (match[1] === '' && match[3] === '')) {
      return { error: `Use page numbers and ranges, ${EXAMPLE}.` }
    }
    const [, start, dash, end] = match
    const from = start === '' ? 1 : Number(start)
    const to = dash === '' ? from : end === '' ? count : Number(end)
    for (const n of [from, to]) {
      if (n < 1 || n > count) {
        return {
          error:
            count === 1
              ? `This drawing has 1 page, so page ${n} doesn't exist.`
              : `Page ${n} doesn't exist: pages run from 1 to ${count}.`,
        }
      }
    }
    if (from > to) return { error: `${item} runs backwards; write it as ${to}-${from}.` }
    for (let n = from; n <= to; n++) picked.add(n - 1)
  }
  return { pages: [...picked].sort((a, b) => a - b) }
}
