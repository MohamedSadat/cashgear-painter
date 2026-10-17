import { applyDraft, startDraft } from '../lib/images/crop'
import { sameTransform } from '../lib/geometry/transform'
import { isPickable, useEditorStore, type EditorState } from '../store/editorStore'
import type { Doc, ImageNode, NodeId } from '../types'

const store = () => useEditorStore.getState()

/** The image node and its asset's record, when it can be cropped on the page: shown, unlocked. */
function croppable(doc: Doc, id: NodeId, pageId: string) {
  const node = doc.nodes[id]
  if (node?.type !== 'image' || !isPickable(doc, id, pageId)) return null
  const asset = doc.assets[node.assetId]
  return asset ? { node, asset } : null
}

/** Whether the node is an image that crop mode can open on. */
export function canCrop(doc: Doc, id: NodeId, pageId: string): boolean {
  return croppable(doc, id, pageId) !== null
}

/**
 * Opens crop mode on an image: the whole image shows dimmed, with a box over the part that will
 * show. Its handles crop, and dragging the image moves it inside the box (CropOverlay). Nothing
 * changes until the crop is applied.
 */
export function startCrop(id: NodeId): void {
  const { cropping, doc, currentPageId } = store()
  if (cropping?.id === id) return
  applyCrop()
  const found = croppable(doc, id, currentPageId)
  if (!found) return
  store().select([id])
  store().setCropping(startDraft(found.node, found.asset))
}

const sameCrop = (a: ImageNode['crop'], b: ImageNode['crop']) =>
  a === b ||
  (a !== null &&
    b !== null &&
    a.x === b.x &&
    a.y === b.y &&
    a.width === b.width &&
    a.height === b.height)

/** Closes crop mode, applying the crop as one undo step; none when nothing changed. */
export function applyCrop(): void {
  const { cropping, doc } = store()
  if (!cropping) return
  store().setCropping(null)
  const node = doc.nodes[cropping.id]
  const asset = node?.type === 'image' ? doc.assets[node.assetId] : undefined
  if (node?.type !== 'image' || !asset) return
  const changes = applyDraft(node, asset, cropping)
  const unchanged =
    sameTransform(changes.transform, node.transform) &&
    changes.width === node.width &&
    changes.height === node.height &&
    sameCrop(changes.crop, node.crop)
  if (!unchanged) store().updateNodes({ [node.id]: changes })
}

/** Closes crop mode, leaving the image as it was. */
export function cancelCrop(): void {
  if (store().cropping) store().setCropping(null)
}

/** In crop mode, shows the whole image in the box, without leaving crop mode. */
export function showWholeImage(): void {
  const { cropping } = store()
  if (cropping) store().setCropping({ ...cropping, box: cropping.frame })
}

type CropState = Pick<EditorState, 'cropping' | 'tool' | 'currentPageId' | 'doc'>

interface CropStore {
  getState(): CropState
  subscribe(listener: (state: CropState, previous: CropState) => void): () => void
}

/**
 * Ends crop mode when the editor moves on: another tool or page applies the crop (the hand tool,
 * Space's pan, doesn't), and an image that goes away or can't be picked any more (undone, hidden,
 * locked) cancels it. Returns a function that stops watching.
 */
export function watchCrop(cropStore: CropStore = useEditorStore): () => void {
  return cropStore.subscribe((state, previous) => {
    const { cropping } = state
    if (!cropping || !previous.cropping) return
    if (state.currentPageId !== previous.currentPageId) applyCrop()
    else if (state.tool !== previous.tool && state.tool !== 'select' && state.tool !== 'hand') {
      applyCrop()
    } else if (
      state.doc !== previous.doc &&
      !canCrop(state.doc, cropping.id, state.currentPageId)
    ) {
      cancelCrop()
    }
  })
}
