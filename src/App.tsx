import type Konva from 'konva'
import { useRef, useState, useSyncExternalStore } from 'react'
import { CanvasStage } from './components/CanvasStage'
import { LayersPanel } from './components/LayersPanel'
import { PagesPanel } from './components/PagesPanel'
import { PropertiesPanel } from './components/PropertiesPanel'
import { Toast } from './components/Toast'
import { ToolRail } from './components/ToolRail'
import { useFileInput } from './hooks/useFileInput'
import { useShortcuts } from './hooks/useShortcuts'
import { exportPng } from './lib/exportPng'
import { assetCache } from './lib/images/assets'
import { pageSubtree } from './lib/pages'
import { currentPageOf, useEditorStore } from './store/editorStore'
import { settleTool } from './tools'

type PanelTab = 'properties' | 'layers' | 'pages'

const TABS: { id: PanelTab; label: string }[] = [
  { id: 'properties', label: 'Properties' },
  { id: 'layers', label: 'Layers' },
  { id: 'pages', label: 'Pages' },
]

// Tailwind's sm breakpoint, where the panels leave the bottom sheet.
const WIDE = '(min-width: 40rem)'

function subscribeWide(onChange: () => void): () => void {
  const query = window.matchMedia(WIDE)
  query.addEventListener('change', onChange)
  return () => query.removeEventListener('change', onChange)
}

/** Whether the screen is 640 px wide or more. */
function useIsWide(): boolean {
  return useSyncExternalStore(subscribeWide, () => window.matchMedia(WIDE).matches)
}

export default function App() {
  const stageRef = useRef<Konva.Stage>(null)
  const [tab, setTab] = useState<PanelTab>('properties')
  const wide = useIsWide()
  useShortcuts()
  useFileInput()

  // Images still loading would be gray boxes in the PNG, so the export waits for them, and for
  // the frame that draws them.
  const handleExport = async () => {
    settleTool()
    const before = useEditorStore.getState()
    const assets = pageSubtree(before.doc, currentPageOf(before).id).flatMap((node) =>
      node.type === 'image' ? [node.assetId] : [],
    )
    if (assets.length > 0) {
      await assetCache.whenSettled(assets)
      await new Promise((resolve) => requestAnimationFrame(resolve))
    }
    const stage = stageRef.current
    if (!stage) return
    const state = useEditorStore.getState()
    const page = currentPageOf(state)
    const ratio = exportPng(stage, page)
    if (ratio < 2) {
      const size = `${Math.round(page.width * ratio)} × ${Math.round(page.height * ratio)}`
      state.showToast(`This page is too large to export at twice its size; the PNG is ${size}.`)
    }
  }

  // Shown on phones only for the open tab; from 640 px up, always.
  const shownOn = (id: PanelTab) => (tab === id ? 'flex-1' : 'hidden sm:flex')

  // Phones stack the rail, canvas and panels; from 640 px up they sit side by side. On phones the
  // panels are tabs of a bottom sheet of fixed height, so the canvas doesn't jump as they change.
  // From 640 px up, the pages are a strip left of the canvas, and the properties sit above the
  // layers on the right.
  return (
    <div className="flex h-dvh flex-col bg-neutral-100 sm:flex-row">
      <ToolRail onExportPng={handleExport} />
      {wide && (
        <PagesPanel layout="strip" className="w-28 shrink-0 border-r border-neutral-200 bg-white" />
      )}
      <CanvasStage stageRef={stageRef} />
      <div className="flex h-56 shrink-0 flex-col border-t border-neutral-200 bg-white sm:h-auto sm:w-72 sm:border-t-0 sm:border-l">
        <div
          role="tablist"
          aria-label="Panels"
          className="flex shrink-0 border-b border-neutral-200 sm:hidden"
        >
          {TABS.map(({ id, label }) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              onClick={() => setTab(id)}
              className={`h-8 flex-1 text-xs font-medium ${
                tab === id ? 'border-b-2 border-sky-500 text-sky-700' : 'text-neutral-500'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        {/* A fixed share of the column, so the layers don't move as the properties change. */}
        <PropertiesPanel className={`${shownOn('properties')} sm:h-[55%] sm:flex-none`} />
        <LayersPanel
          className={`${shownOn('layers')} sm:flex-1 sm:border-t sm:border-neutral-200`}
        />
        {!wide && <PagesPanel layout="row" className={tab === 'pages' ? 'flex-1' : 'hidden'} />}
      </div>
      <Toast />
    </div>
  )
}
