import type Konva from 'konva'
import { useRef } from 'react'
import { CanvasStage } from './components/CanvasStage'
import { Toolbar } from './components/Toolbar'
import { useShortcuts } from './hooks/useShortcuts'
import { exportPng } from './lib/exportPng'

export default function App() {
  const stageRef = useRef<Konva.Stage>(null)
  useShortcuts()

  const handleExport = () => {
    if (stageRef.current) exportPng(stageRef.current)
  }

  return (
    <div className="flex h-dvh flex-col bg-neutral-100">
      <Toolbar onExport={handleExport} />
      <CanvasStage stageRef={stageRef} />
    </div>
  )
}
