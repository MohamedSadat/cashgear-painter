import { describe, expect, it } from 'vitest'
import { DEFAULT_TEXT_STYLE, createTextNode } from '../../store/editorStore'
import {
  TEXT_LINE_HEIGHT,
  WEB_SAFE_FONTS,
  canvasFont,
  quoteFamilies,
  textHeight,
  textLines,
  wrapText,
} from './textLayout'

// Every character is 10 units wide.
const measure = (text: string) => Array.from(text).length * 10

describe('wrapText', () => {
  it('keeps lines that fit, and breaks at newlines', () => {
    expect(wrapText('one two', 100, measure)).toEqual(['one two'])
    expect(wrapText('one\n\ntwo', 100, measure)).toEqual(['one', '', 'two'])
  })

  it('wraps at the last space or dash that fits, dropping the spaces at the break', () => {
    expect(wrapText('one two three', 80, measure)).toEqual(['one two', 'three'])
    expect(wrapText('one   two', 50, measure)).toEqual(['one', 'two'])
    expect(wrapText('well-known', 60, measure)).toEqual(['well-', 'known'])
  })

  it('breaks a word wider than the line between characters', () => {
    expect(wrapText('abcdefghij', 40, measure)).toEqual(['abcd', 'efgh', 'ij'])
  })

  it('stops a paragraph where not even one character fits, as Konva does', () => {
    expect(wrapText('abc\nd', 5, measure)).toEqual([])
    expect(wrapText('', 5, measure)).toEqual([''])
  })
})

describe('text nodes', () => {
  it('lays out a text in its width, one line height per line', () => {
    // Without a canvas, a glyph is 0.6 em: 6 units at size 10.
    const style = { ...DEFAULT_TEXT_STYLE, fontSize: 10 }
    const node = createTextNode(0, 0, 30, style, 'aaaa bbbb cc')
    expect(textLines(node)).toEqual(['aaaa', 'bbbb', 'cc'])
    expect(textHeight(node)).toBeCloseTo(3 * 10 * TEXT_LINE_HEIGHT)
    expect(textHeight({ ...node, text: '' })).toBeCloseTo(10 * TEXT_LINE_HEIGHT)
  })

  it('writes the font as Konva does, with multi-word families quoted', () => {
    expect(quoteFamilies('Courier New, Courier, monospace')).toBe(
      '"Courier New", Courier, monospace',
    )
    expect(
      canvasFont({ fontStyle: 'bold italic', fontSize: 48, fontFamily: WEB_SAFE_FONTS[0].family }),
    ).toBe('bold italic normal 48px Arial, Helvetica, sans-serif')
  })
})
