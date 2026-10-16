import type { ToolId } from '../types'
import { brushTool } from './brushTool'
import { directTool } from './directTool'
import { eraserTool } from './eraserTool'
import { handTool } from './handTool'
import { penTool } from './penTool'
import { selectTool } from './selectTool'
import { ellipseTool, lineTool, rectTool } from './shapeTools'
import { textTool } from './textTool'
import type { ToolController } from './types'

// CanvasStage only asks for the active tool here; it never names one.
const TOOLS: Record<ToolId, ToolController> = {
  select: selectTool,
  direct: directTool,
  brush: brushTool,
  eraser: eraserTool,
  rect: rectTool,
  ellipse: ellipseTool,
  line: lineTool,
  pen: penTool,
  text: textTool,
  hand: handTool,
}

export function toolFor(id: ToolId): ToolController | undefined {
  return TOOLS[id]
}
