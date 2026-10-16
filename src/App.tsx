import type Konva from 'konva'
import { useRef, useState } from 'react'
import { CanvasStage } from './components/CanvasStage'
import { LayersPanel } from './components/LayersPanel'
import { PropertiesPanel } from './components/PropertiesPanel'
import { ToolRail } from './components/ToolRail'
import { useShortcuts } from './hooks/useShortcuts'
import { exportPng } from './lib/exportPng'

type PanelTab = 'properties' | 'layers'

const TABS: { id: PanelTab; label: string }[] = [
  { id: 'properties', label: 'Properties' },
  { id: 'layers', label: 'Layers' },
]

export default function App() {
  const stageRef = useRef<Konva.Stage>(null)
  const [tab, setTab] = useState<PanelTab>('properties')
  useShortcuts()

  const handleExport = () => {
    if (stageRef.current) exportPng(stageRef.current)
  }

  // Shown on phones only for the open tab; from 640 px up, always.
  const shownOn = (id: PanelTab) => (tab === id ? 'flex-1' : 'hidden sm:flex')

  // Phones stack the rail, canvas and panels; from 640 px up they sit side by side. On phones the
  // panels are tabs of a bottom sheet of fixed height, so the canvas doesn't jump as they change;
  // on the right, the properties sit above the layers.
  return (
    <div className="flex h-dvh flex-col bg-neutral-100 sm:flex-row">
      <ToolRail onExport={handleExport} />
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
      </div>
    </div>
  )
}
