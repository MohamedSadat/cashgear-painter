import type { ToolId } from '../types'
import { brushTool } from './brushTool'
import { eraserTool } from './eraserTool'
import { handTool } from './handTool'
import type { ToolController } from './types'

// Each milestone registers its tools here; CanvasStage only asks for the active one.
const TOOLS: Partial<Record<ToolId, ToolController>> = {
  brush: brushTool,
  eraser: eraserTool,
  hand: handTool,
}

export function toolFor(id: ToolId): ToolController | undefined {
  return TOOLS[id]
}
