import { X } from 'lucide-react'
import { useEffect } from 'react'
import { useEditorStore } from '../store/editorStore'

const SHOW_MS = 6000

/**
 * The store's toast, such as what an SVG import skipped, for a few seconds or until dismissed.
 * Above the bottom sheet on phones, at the bottom of the canvas from 640 px up. The live region
 * stays in the page so screen readers announce each new message.
 */
export function Toast() {
  const toast = useEditorStore((s) => s.toast)
  const dismissToast = useEditorStore((s) => s.dismissToast)

  useEffect(() => {
    if (!toast) return
    const timer = setTimeout(() => dismissToast(toast.id), SHOW_MS)
    return () => clearTimeout(timer)
  }, [toast, dismissToast])

  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none fixed inset-x-0 bottom-60 z-50 flex justify-center px-4 sm:bottom-6"
    >
      {toast && (
        <div className="pointer-events-auto flex max-w-md items-start gap-2 rounded-lg bg-neutral-800 py-2 pr-2 pl-3 text-sm text-white shadow-lg">
          <span className="py-1">{toast.message}</span>
          <button
            type="button"
            aria-label="Dismiss"
            onClick={() => dismissToast(toast.id)}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md hover:bg-neutral-700"
          >
            <X size={16} />
          </button>
        </div>
      )}
    </div>
  )
}
