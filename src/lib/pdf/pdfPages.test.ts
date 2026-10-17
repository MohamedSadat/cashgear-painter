import { describe, expect, it } from 'vitest'
import { PAGE_PRESETS } from '../pages'
import { IMAGE_MODE_RATIO, PT_PER_PX, parsePageRange, pdfPageSize } from './pdfPages'

describe('pdfPageSize', () => {
  it('gives sizes in points, CSS px × 0.75', () => {
    expect(PT_PER_PX).toBe(0.75)
    // A4 is 794 × 1123 px at 96 dpi, so 595.5 × 842.25 pt, within half a point of 210 × 297 mm.
    expect(pdfPageSize({ width: 794, height: 1123 })).toEqual({
      width: 595.5,
      height: 842.25,
      orientation: 'portrait',
    })
    expect(pdfPageSize({ width: 816, height: 1056 })).toMatchObject({ width: 612, height: 792 })
  })

  it('names the orientation the page has, so jsPDF keeps its sides', () => {
    expect(pdfPageSize({ width: 1123, height: 794 })).toEqual({
      width: 842.25,
      height: 595.5,
      orientation: 'landscape',
    })
    expect(pdfPageSize({ width: 1600, height: 1000 }).orientation).toBe('landscape')
    // A square needs no swap either way.
    expect(pdfPageSize({ width: 1080, height: 1080 }).orientation).toBe('portrait')
  })

  it('sizes every preset', () => {
    for (const preset of PAGE_PRESETS) {
      const size = pdfPageSize(preset)
      expect(size.width).toBeCloseTo(preset.width * 0.75)
      expect(size.height).toBeCloseTo(preset.height * 0.75)
      expect(size.orientation === 'landscape').toBe(preset.width > preset.height)
    }
  })

  it('draws image mode at 300 dpi', () => {
    expect(IMAGE_MODE_RATIO).toBe(3.125)
  })
})

describe('parsePageRange', () => {
  it('reads pages and ranges separated by commas or spaces', () => {
    expect(parsePageRange('1-3, 5', 6)).toEqual({ pages: [0, 1, 2, 4] })
    expect(parsePageRange('2', 3)).toEqual({ pages: [1] })
    expect(parsePageRange(' 1 , 3 ', 3)).toEqual({ pages: [0, 2] })
    expect(parsePageRange('1 3;4', 4)).toEqual({ pages: [0, 2, 3] })
    expect(parsePageRange('2 - 3', 3)).toEqual({ pages: [1, 2] })
    expect(parsePageRange('2–3', 3)).toEqual({ pages: [1, 2] })
    expect(parsePageRange('3-3', 3)).toEqual({ pages: [2] })
  })

  it('keeps the doc order and each page once', () => {
    expect(parsePageRange('5, 1-3, 2', 5)).toEqual({ pages: [0, 1, 2, 4] })
  })

  it('runs an open range to the first or last page', () => {
    expect(parsePageRange('3-', 5)).toEqual({ pages: [2, 3, 4] })
    expect(parsePageRange('-2', 5)).toEqual({ pages: [0, 1] })
  })

  it('refuses empty, malformed, missing and backwards ranges, saying why', () => {
    expect(parsePageRange('', 3).error).toBe('Type the pages to export, such as 1-3, 5.')
    expect(parsePageRange(' , ', 3).error).toBe('Type the pages to export, such as 1-3, 5.')
    for (const text of ['a', '1-2-3', '-', '1.5', '2x']) {
      expect(parsePageRange(text, 3).error).toBe('Use page numbers and ranges, such as 1-3, 5.')
    }
    expect(parsePageRange('0', 3).error).toBe("Page 0 doesn't exist: pages run from 1 to 3.")
    expect(parsePageRange('2-7', 3).error).toBe("Page 7 doesn't exist: pages run from 1 to 3.")
    expect(parsePageRange('2', 1).error).toBe("This drawing has 1 page, so page 2 doesn't exist.")
    expect(parsePageRange('3-1', 3).error).toBe('3-1 runs backwards; write it as 1-3.')
  })
})
