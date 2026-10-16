import type { NodeId } from '../types'

export interface ToolEvent {
  point: [number, number] // canvas units
  pressure: number
  pointerType: string
  shift: boolean
  alt: boolean
  mod: boolean // Ctrl or Cmd
  target: NodeId | null
  // The pointer event's own time in ms (its `timeStamp`), not when it was handled, which a busy
  // main thread can delay.
  timeStamp: number
}

export interface ToolController {
  cursor: string
  // Pointer-downs carry the node under the pointer in `target`. Only these tools pay for Konva's
  // hit canvas; for the rest the content layer doesn't listen.
  picksNodes?: boolean
  onDown(e: ToolEvent): void
  onMove(e: ToolEvent): void
  onUp(e: ToolEvent): void
  // Pointer moves with nothing pressed (mice and pens); null when the pointer leaves the canvas.
  onHover?(e: ToolEvent | null): void
  onKey?(e: KeyboardEvent): boolean // true = handled
  onCancel?(): void // Esc or tool switch
  // Ends what the tool is drawing and keeps it, before a page switch or a file action; without
  // it, onCancel does.
  onSettle?(): void
}
