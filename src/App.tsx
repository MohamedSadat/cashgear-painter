import type Konva from 'konva'
import { useRef } from 'react'
import { CanvasStage } from './components/CanvasStage'
import { PropertiesPanel } from './components/PropertiesPanel'
import { ToolRail } from './components/ToolRail'
import { useShortcuts } from './hooks/useShortcuts'
import { exportPng } from './lib/exportPng'

export default function App() {
  const stageRef = useRef<Konva.Stage>(null)
  useShortcuts()

  const handleExport = () => {
    if (stageRef.current) exportPng(stageRef.current)
  }

  // Phones stack the rail, canvas and properties; from 640 px up they sit side by side.
  return (
    <div className="flex h-dvh flex-col bg-neutral-100 sm:flex-row">
      <ToolRail onExport={handleExport} />
      <CanvasStage stageRef={stageRef} />
      <PropertiesPanel />
    </div>
  )
}
