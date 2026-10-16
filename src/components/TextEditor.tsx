import { useLayoutEffect, useRef, type CSSProperties } from 'react'
import { TEXT_LINE_HEIGHT } from '../lib/geometry/textLayout'
import { absoluteTransform } from '../lib/geometry/transform'
import { fillColor } from '../lib/paint/paint'
import { useEditorStore, zoomOf } from '../store/editorStore'
import { cancelTextEdit, finishTextEdit } from '../tools/textTool'
import { ACCENT } from './overlayStyle'

// iOS zooms the page into a text field whose font is smaller than this; smaller text is drawn at
// this size and scaled down instead.
const MIN_FIELD_FONT_PX = 16

/**
 * The textarea that edits a text node, laid over the canvas where the hidden Konva text is. It is
 * placed from the model (the node's transform through its groups, then the view), so it follows
 * zoom, pan and resizes in the same render. Typing updates the node inside the edit's gesture;
 * blur or Ctrl/Cmd + Enter keeps the edit, Esc puts the text back.
 */
export function TextEditor() {
  const ref = useRef<HTMLTextAreaElement>(null)
  const id = useEditorStore((s) => s.editingText)
  const nodes = useEditorStore((s) => s.doc.nodes)
  const view = useEditorStore((s) => s.view)
  const zoom = useEditorStore(zoomOf)
  const node = id === null ? undefined : nodes[id]

  // Focused in a layout effect, still inside the tap that opened it, so phones raise the keyboard.
  useLayoutEffect(() => {
    const field = ref.current
    if (!field) return
    field.focus({ preventScroll: true })
    field.setSelectionRange(field.value.length, field.value.length)
  }, [id])

  // The field grows with its lines instead of scrolling.
  useLayoutEffect(() => {
    const field = ref.current
    if (!field) return
    field.style.height = '0px'
    field.style.height = `${field.scrollHeight}px`
  })

  if (node?.type !== 'text') return null
  const t = absoluteTransform(nodes, node.id)
  const fontPx = node.fontSize * Math.abs(t.scaleY) * zoom
  const fieldFont = Math.max(MIN_FIELD_FONT_PX, fontPx)
  const shrink = fontPx / fieldFont
  const style: CSSProperties = {
    left: view.x + t.x * zoom,
    top: view.y + t.y * zoom,
    width: (node.width * Math.abs(t.scaleX) * zoom) / shrink,
    transform: `rotate(${t.rotation}deg) scale(${shrink})`,
    transformOrigin: '0 0',
    fontFamily: node.fontFamily,
    fontSize: fieldFont,
    fontWeight: node.fontStyle.includes('bold') ? 'bold' : 'normal',
    fontStyle: node.fontStyle.includes('italic') ? 'italic' : 'normal',
    lineHeight: TEXT_LINE_HEIGHT,
    textAlign: node.align,
    color: fillColor(node.style.fill) ?? '#000000',
    opacity: node.style.opacity,
    outline: `${1 / shrink}px dashed ${ACCENT}`,
    outlineOffset: 2 / shrink,
  }
  const textId = node.id

  return (
    <textarea
      ref={ref}
      aria-label="Text"
      value={node.text}
      spellCheck={false}
      rows={1}
      style={style}
      className="absolute m-0 resize-none overflow-hidden border-0 bg-transparent p-0 break-words whitespace-pre-wrap select-text [-webkit-touch-callout:default]"
      onChange={(e) =>
        useEditorStore.getState().updateNodes({ [textId]: { text: e.target.value } })
      }
      onBlur={finishTextEdit}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault()
          cancelTextEdit()
        } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
          e.preventDefault()
          finishTextEdit()
        }
      }}
    />
  )
}
