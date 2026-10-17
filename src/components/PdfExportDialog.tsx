import { TriangleAlert } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { exportPdfFile } from '../lib/fileActions'
import type { PdfMode } from '../lib/pdf/exportPdf'
import { pdfWarnings } from '../lib/pdf/pdfFonts'
import { parsePageRange } from '../lib/pdf/pdfPages'
import { useEditorStore } from '../store/editorStore'

type Which = 'all' | 'range'

interface Progress {
  done: number
  total: number
}

const RADIO = 'mt-0.5 shrink-0 accent-sky-600'
const LEGEND = 'mb-1 text-xs font-semibold text-neutral-800'

function Choice({
  name,
  checked,
  onPick,
  children,
}: {
  name: string
  checked: boolean
  onPick(): void
  children: ReactNode
}) {
  return (
    <label className="flex items-start gap-2 py-1 text-sm text-neutral-800">
      <input type="radio" name={name} checked={checked} onChange={onPick} className={RADIO} />
      <span className="min-w-0">{children}</span>
    </label>
  )
}

/**
 * Exports pages as a PDF: all of them or a range like "1-3, 5", as vectors (the default) or as
 * 300 dpi images. Vector mode lists what the PDF shows differently: fonts it has no match for,
 * and pages drawn as images. A progress bar counts pages; Cancel or Esc stops between pages. A
 * modal <dialog>, so the canvas can't be reached meanwhile, and its keys stay away from the
 * canvas shortcuts.
 */
export function PdfExportDialog({ onClose }: { onClose(): void }) {
  const doc = useEditorStore((s) => s.doc)
  const currentPageId = useEditorStore((s) => s.currentPageId)
  const dialogRef = useRef<HTMLDialogElement>(null)
  const abortRef = useRef<AbortController | null>(null)
  const [which, setWhich] = useState<Which>('all')
  const [range, setRange] = useState('')
  const [mode, setMode] = useState<PdfMode>('vector')
  const [progress, setProgress] = useState<Progress | null>(null)
  const [failure, setFailure] = useState<string | null>(null)

  useEffect(() => {
    const dialog = dialogRef.current
    if (dialog && !dialog.open) dialog.showModal()
    return () => abortRef.current?.abort()
  }, [])

  const count = doc.pages.length
  const parsed = useMemo(
    () => (which === 'all' ? { pages: doc.pages.map((_, i) => i) } : parsePageRange(range, count)),
    [which, range, count, doc.pages],
  )
  const pageIds = useMemo(() => parsed.pages?.map((i) => doc.pages[i].id) ?? [], [parsed, doc])
  const warnings = useMemo(
    () => (mode === 'vector' ? pdfWarnings(doc, pageIds) : []),
    [mode, doc, pageIds],
  )
  const busy = progress !== null

  const close = () => {
    abortRef.current?.abort()
    dialogRef.current?.close()
    onClose()
  }

  const pickRange = () => {
    setWhich('range')
    // The current page, a start the user can edit.
    if (range === '') setRange(String(doc.pages.findIndex((p) => p.id === currentPageId) + 1))
  }

  const start = async () => {
    if (busy || pageIds.length === 0) return
    const controller = new AbortController()
    abortRef.current = controller
    setFailure(null)
    setProgress({ done: 0, total: pageIds.length })
    try {
      await exportPdfFile({
        pageIds,
        mode,
        signal: controller.signal,
        onProgress: (done, total) => setProgress({ done, total }),
      })
      if (!controller.signal.aborted) close()
    } catch (error) {
      if (controller.signal.aborted) return
      setFailure(
        error instanceof Error && error.message ? error.message : "The PDF couldn't be made.",
      )
      setProgress(null)
    }
  }

  // The canvas shortcuts listen on the window; a key pressed in here is the dialog's own.
  const onKeyDown = (e: KeyboardEvent) => e.stopPropagation()

  const rangeError = which === 'range' ? parsed.error : undefined
  const pagesLabel = count === 1 ? 'The page' : `All ${count} pages`

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby="pdf-dialog-title"
      onCancel={(e) => {
        e.preventDefault()
        close()
      }}
      onKeyDown={onKeyDown}
      className="m-auto w-[calc(100%-2rem)] max-w-sm rounded-xl bg-white p-0 text-neutral-800 shadow-xl backdrop:bg-neutral-900/30"
    >
      <form
        onSubmit={(e) => {
          e.preventDefault()
          void start()
        }}
        className="flex flex-col gap-3 p-4"
      >
        <h2 id="pdf-dialog-title" className="text-base font-semibold">
          Export PDF
        </h2>
        <fieldset disabled={busy} className="min-w-0">
          <legend className={LEGEND}>Pages</legend>
          <Choice name="pdf-pages" checked={which === 'all'} onPick={() => setWhich('all')}>
            {pagesLabel}
          </Choice>
          <div className="flex items-center gap-2">
            <Choice name="pdf-pages" checked={which === 'range'} onPick={pickRange}>
              Pages
            </Choice>
            <input
              type="text"
              aria-label="Page range"
              placeholder="1-3, 5"
              value={range}
              onFocus={() => setWhich('range')}
              onChange={(e) => {
                setWhich('range')
                setRange(e.target.value)
              }}
              aria-invalid={rangeError !== undefined}
              aria-describedby="pdf-range-note"
              className="h-8 min-w-0 flex-1 rounded-md border border-neutral-300 bg-white px-2 text-sm aria-[invalid=true]:border-red-400"
            />
          </div>
          <p
            id="pdf-range-note"
            className={`mt-1 text-xs ${rangeError ? 'text-red-600' : 'text-neutral-500'}`}
          >
            {rangeError ?? `Page numbers and ranges from 1 to ${count}, such as 1-3, 5.`}
          </p>
        </fieldset>
        <fieldset disabled={busy} className="min-w-0">
          <legend className={LEGEND}>Mode</legend>
          <Choice name="pdf-mode" checked={mode === 'vector'} onPick={() => setMode('vector')}>
            Vector
            <span className="block text-xs text-neutral-500">
              Sharp at any size, with selectable text
            </span>
          </Choice>
          <Choice name="pdf-mode" checked={mode === 'image'} onPick={() => setMode('image')}>
            Image
            <span className="block text-xs text-neutral-500">
              Each page a 300 dpi picture, exactly as on screen; no selectable text
            </span>
          </Choice>
        </fieldset>
        {warnings.length > 0 && (
          <ul aria-label="Warnings" className="flex flex-col gap-1.5 rounded-md bg-amber-50 p-2">
            {warnings.map((warning) => (
              <li key={warning} className="flex gap-2 text-xs text-amber-900">
                <TriangleAlert size={14} aria-hidden className="mt-px shrink-0 text-amber-600" />
                <span>{warning}</span>
              </li>
            ))}
          </ul>
        )}
        {progress && (
          <div className="flex items-center gap-2">
            <progress
              aria-label="Export progress"
              value={progress.done}
              max={progress.total}
              className="h-2 min-w-0 flex-1 accent-sky-600"
            />
            <span className="text-xs text-neutral-600 tabular-nums">
              {progress.done < progress.total
                ? `Page ${progress.done + 1} of ${progress.total}`
                : 'Saving…'}
            </span>
          </div>
        )}
        {failure && (
          <p role="alert" className="text-xs text-red-600">
            {failure}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={close}
            className="h-9 rounded-md px-3 text-sm text-neutral-700 hover:bg-neutral-100"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy || pageIds.length === 0}
            className="h-9 rounded-md bg-sky-600 px-4 text-sm font-medium text-white enabled:hover:bg-sky-700 disabled:opacity-40"
          >
            Export
          </button>
        </div>
      </form>
    </dialog>
  )
}
