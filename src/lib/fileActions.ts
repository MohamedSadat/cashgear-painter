import { useEditorStore } from '../store/editorStore'
import { toolFor } from '../tools'
import { chooseFile, downloadText } from './files'
import { DOC_FILE_NAME, docToJson, parseDocFile } from './persistence'
import { SVG_FILE_NAME, exportSvg } from './svg/exportSvg'
import { importSvg } from './svg/importSvg'

const store = () => useEditorStore.getState()

const errorMessage = (error: unknown, fallback: string) =>
  error instanceof Error && error.message ? error.message : fallback

/** Ends what the active tool is drawing, such as a pen path, as a tool switch would. */
function settleTool() {
  toolFor(store().tool)?.onCancel?.()
}

/** Downloads the drawing as drawing.painter.json. */
export function saveDrawing(): void {
  settleTool()
  downloadText(docToJson(store().doc), DOC_FILE_NAME, 'application/json')
}

/**
 * Opens a .painter.json file in place of the drawing, as one undo step, so Undo brings the
 * previous drawing back. A file that isn't a drawing, or comes from an unknown version, changes
 * nothing and says so in a toast.
 */
export async function openDrawing(): Promise<void> {
  const file = await chooseFile('.json,application/json')
  if (!file) return
  try {
    const doc = parseDocFile(await file.text())
    settleTool()
    store().replaceDoc(doc)
  } catch (error) {
    store().showToast(errorMessage(error, "The file couldn't be opened."))
  }
}

/** Downloads the drawing as drawing.svg. */
export function exportSvgFile(): void {
  settleTool()
  downloadText(exportSvg(store().doc), SVG_FILE_NAME, 'image/svg+xml')
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

/**
 * Adds an SVG file's shapes as one group on top, one undo step, named after the file. The group
 * is selected and the select tool takes over, as after drawing a shape. A toast says how many
 * elements were skipped.
 */
export async function importSvgFile(): Promise<void> {
  const file = await chooseFile('.svg,image/svg+xml')
  if (!file) return
  try {
    const name = file.name.replace(/\.svg$/i, '') || 'Imported SVG'
    const { nodes, groupId, skipped } = importSvg(await file.text(), name)
    const unsupported = `Skipped ${plural(skipped, 'unsupported element')} (text, images, gradients and the like).`
    if (!groupId) {
      store().showToast(skipped > 0 ? `Nothing to import. ${unsupported}` : 'Nothing to import.')
      return
    }
    settleTool()
    const { addNodes, select, setTool, showToast } = store()
    addNodes(nodes)
    setTool('select')
    select([groupId])
    if (skipped > 0) showToast(`Imported ${name}. ${unsupported}`)
  } catch (error) {
    store().showToast(errorMessage(error, "The SVG couldn't be imported."))
  }
}
