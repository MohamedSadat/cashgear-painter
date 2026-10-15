import type { NodeId } from '../types'

export interface ToolEvent {
  point: [number, number] // canvas units
  pressure: number
  pointerType: string
  shift: boolean
  alt: boolean
  mod: boolean // Ctrl or Cmd
  target: NodeId | null
}

export interface ToolController {
  cursor: string
  onDown(e: ToolEvent): void
  onMove(e: ToolEvent): void
  onUp(e: ToolEvent): void
  onKey?(e: KeyboardEvent): boolean // true = handled
  onCancel?(): void // Esc or tool switch
}
