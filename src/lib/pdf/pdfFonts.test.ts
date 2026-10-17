import { describe, expect, it } from 'vitest'
import { DEFAULT_TEXT_STYLE, createGroupNode, createTextNode } from '../../store/editorStore'
import { WEB_SAFE_FONTS } from '../geometry/textLayout'
import { emptyDoc, newPage, type Doc, type TextNode } from '../../types'
import {
  EMBEDDED_FAMILY,
  EMBEDDED_FILES,
  joinWords,
  pageFonts,
  pdfCanShow,
  pdfFontOf,
  pdfFontStyle,
  pdfWarnings,
  visibleTexts,
} from './pdfFonts'

const familyOf = (label: string) => WEB_SAFE_FONTS.find((f) => f.label === label)!.family

const text = (
  id: string,
  font: string,
  words: string,
  extra: Partial<TextNode> = {},
): TextNode => ({
  ...createTextNode(0, 0, 400, { ...DEFAULT_TEXT_STYLE, fontFamily: familyOf(font) }, words, id),
  ...extra,
})

/** Pages p1, p2 and p3 holding the given texts. */
function docWith(pages: TextNode[][]): Doc {
  const doc = emptyDoc()
  doc.pages = pages.map((texts, i) => ({
    ...newPage(`p${i + 1}`, `Page ${i + 1}`),
    rootIds: texts.map((t) => t.id),
  }))
  for (const t of pages.flat()) doc.nodes[t.id] = t
  return doc
}

describe('pdfFontOf', () => {
  it('maps the web-safe fonts to a PDF font of the same metrics', () => {
    expect(pdfFontOf(familyOf('Arial'))).toEqual({ family: 'helvetica', mapped: true })
    expect(pdfFontOf(familyOf('Times New Roman'))).toEqual({ family: 'times', mapped: true })
    expect(pdfFontOf(familyOf('Courier New'))).toEqual({ family: 'courier', mapped: true })
    expect(pdfFontOf(familyOf('Georgia'))).toEqual({ family: EMBEDDED_FAMILY, mapped: true })
  })

  it("stands in the stack's next match, or Helvetica, for a font without one", () => {
    expect(pdfFontOf(familyOf('Verdana'))).toEqual({ family: 'helvetica', mapped: false })
    expect(pdfFontOf(familyOf('Trebuchet MS'))).toEqual({ family: 'helvetica', mapped: false })
    expect(pdfFontOf('Palatino, serif')).toEqual({ family: 'times', mapped: false })
    expect(pdfFontOf('Comic Sans MS')).toEqual({ family: 'helvetica', mapped: false })
    expect(pdfFontOf('')).toEqual({ family: 'helvetica', mapped: false })
  })

  it('reads names quoted or not, in any case', () => {
    expect(pdfFontOf('"Times New Roman", serif')).toEqual({ family: 'times', mapped: true })
    expect(pdfFontOf("'COURIER NEW'")).toEqual({ family: 'courier', mapped: true })
    expect(pdfFontOf('  helvetica ')).toEqual({ family: 'helvetica', mapped: true })
    expect(pdfFontOf('monospace')).toEqual({ family: 'courier', mapped: true })
  })

  it('names the four styles jsPDF knows, each with its embedded file', () => {
    expect(pdfFontStyle('normal')).toBe('normal')
    expect(pdfFontStyle('bold')).toBe('bold')
    expect(pdfFontStyle('italic')).toBe('italic')
    expect(pdfFontStyle('bold italic')).toBe('bolditalic')
    expect(Object.keys(EMBEDDED_FILES).sort()).toEqual(['bold', 'bolditalic', 'italic', 'normal'])
  })
})

describe('pdfCanShow', () => {
  it("takes Windows-1252's characters, as the built-in fonts' encoding has them", () => {
    expect(pdfCanShow('Grüße, café: 25 € “quotes” — ok… ™ Œuvre')).toBe(true)
    expect(pdfCanShow('two\nlines\twith a tab')).toBe(true)
  })

  it('refuses others: other scripts, symbols and emoji', () => {
    for (const s of ['مرحبا', 'Привет', '你好', 'α', '→', '😀', 'ő'])
      expect(pdfCanShow(s)).toBe(false)
  })
})

describe('pageFonts', () => {
  it('lists unmapped fonts once, the embedded styles used, and characters no font has', () => {
    const doc = docWith([
      [
        text('a', 'Verdana', 'One'),
        text('b', 'Verdana', 'Two'),
        text('c', 'Georgia', 'Three', { fontStyle: 'bold italic' }),
        text('d', 'Georgia', 'Four'),
        text('e', 'Arial', 'Five'),
      ],
      [text('f', 'Arial', 'Привет')],
    ])
    const first = pageFonts(doc, 'p1')
    expect(first.unmapped).toEqual([{ name: 'Verdana', family: 'helvetica' }])
    expect([...first.embedded].sort()).toEqual(['bolditalic', 'normal'])
    expect(first.needsImage).toBe(false)
    expect(pageFonts(doc, 'p2').needsImage).toBe(true)
  })

  it('leaves out hidden text, text in hidden groups, and text that draws nothing', () => {
    const doc = docWith([
      [
        text('a', 'Verdana', 'Hidden', { hidden: true }),
        text('b', 'Trebuchet MS', '   '),
        text('c', 'Verdana', 'In a hidden group', { parentId: 'g' }),
      ],
    ])
    doc.nodes.g = { ...createGroupNode(['c'], null, 'g'), hidden: true }
    doc.pages[0].rootIds = ['a', 'b', 'g']
    expect(visibleTexts(doc, 'p1').map((t) => t.id)).toEqual(['b'])
    expect(pageFonts(doc, 'p1')).toEqual({ unmapped: [], embedded: new Set(), needsImage: false })
  })
})

describe('pdfWarnings', () => {
  it('names each unmapped font with its pages, and the pages drawn as images', () => {
    const doc = docWith([
      [text('a', 'Verdana', 'One')],
      [text('b', 'Arial', 'Fine')],
      [text('c', 'Verdana', 'Two'), text('d', 'Trebuchet MS', 'Three')],
      [text('e', 'Verdana', 'مرحبا')],
    ])
    const all = ['p1', 'p2', 'p3', 'p4']
    expect(pdfWarnings(doc, all)).toEqual([
      "Verdana isn't a PDF font, so pages 1 and 3 show it in Helvetica.",
      "Trebuchet MS isn't a PDF font, so page 3 shows it in Helvetica.",
      "Page 4 has characters the PDF's fonts can't show, such as Arabic, Chinese or emoji, so it is drawn as an image, without selectable text.",
    ])
    expect(pdfWarnings(doc, ['p2'])).toEqual([])
    expect(pdfWarnings(doc, ['p3'])).toHaveLength(2)
  })

  it('counts pages drawn as images together', () => {
    const doc = docWith([[text('a', 'Arial', '你好')], [text('b', 'Arial', '😀')]])
    expect(pdfWarnings(doc, ['p1', 'p2'])).toEqual([
      "Pages 1 and 2 have characters the PDF's fonts can't show, such as Arabic, Chinese or emoji, so they are drawn as images, without selectable text.",
    ])
  })

  it('joins words as a sentence lists them', () => {
    expect(joinWords([])).toBe('')
    expect(joinWords([1])).toBe('1')
    expect(joinWords([1, 3])).toBe('1 and 3')
    expect(joinWords([1, 2, 4])).toBe('1, 2 and 4')
  })
})
