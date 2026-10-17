import { useEditorStore } from '../store/editorStore'
import type { ToolId } from '../types'
import { brushTool } from './brushTool'
import { directTool } from './directTool'
import { eraserTool } from './eraserTool'
import { handTool } from './handTool'
import { applyCrop } from './imageCrop'
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

/**
 * Ends what the active tool is drawing, keeping what can be kept, such as a pen path, and applies
 * an open crop: before a page switch or a file action.
 */
export function settleTool(): void {
  applyCrop()
  const tool = toolFor(useEditorStore.getState().tool)
  if (tool?.onSettle) tool.onSettle()
  else tool?.onCancel?.()
}
