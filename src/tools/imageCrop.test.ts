import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { moveBoxEdges } from '../lib/images/crop'
import { useEditorStore } from '../store/editorStore'
import type { AssetMeta, ImageNode } from '../types'
import { applyCrop, cancelCrop, showWholeImage, startCrop, watchCrop } from './imageCrop'
import { selectTool } from './selectTool'
import type { ToolEvent } from './types'

const initialState = useEditorStore.getState()
const store = () => useEditorStore.getState()

const asset: AssetMeta = {
  id: 'a'.repeat(64),
  mime: 'image/png',
  width: 400,
  height: 200,
  bytes: 9,
}

let clock = 0
const press = (x: number, y: number, target: string | null): ToolEvent => ({
  point: [x, y],
  pressure: 0.5,
  pointerType: 'mouse',
  shift: false,
  alt: false,
  mod: false,
  target,
  timeStamp: clock,
})

/** Imports the asset as one image, 400 × 200 in the middle of the page, and returns its id. */
function addImage(): string {
  const [id] = store().importImages([{ asset, name: 'Photo' }])
  return id
}
const node = (id: string) => store().doc.nodes[id] as ImageNode
const keyEvent = (key: string) =>
  ({
    key,
    code: '',
    shiftKey: false,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
  }) as KeyboardEvent

/** Crops the left and top 50 units off the draft, as dragging the top-left handle would. */
function cropTopLeft() {
  const draft = store().cropping!
  store().setCropping(moveBoxEdges(draft, ['left', 'top'], 50, 50))
}

let stopWatching = () => {}

beforeEach(() => {
  useEditorStore.setState(initialState, true)
  store().setViewport({ width: 1000, height: 700, boxWidth: 1600, boxHeight: 1000 })
  stopWatching = watchCrop()
  clock += 1000
})

afterEach(() => stopWatching())

describe('crop mode', () => {
  it('opens on a double-click with the select tool, and on Enter', () => {
    const id = addImage()
    store().select([])
    const { x, y } = node(id).transform
    const click = () => {
      selectTool.onDown(press(x + 10, y + 10, id))
      selectTool.onUp(press(x + 10, y + 10, id))
    }
    click()
    expect(store().cropping).toBeNull()
    click()
    expect(store().cropping).toMatchObject({ id, box: { x: 0, y: 0, width: 400, height: 200 } })
    expect(store().selection).toEqual([id])

    cancelCrop()
    expect(selectTool.onKey!(keyEvent('Enter'))).toBe(true)
    expect(store().cropping?.id).toBe(id)
  })

  it('applies a crop as one undo step, and changes nothing until then', () => {
    const id = addImage()
    const before = node(id)
    const steps = store().past.length
    startCrop(id)
    cropTopLeft()
    expect(node(id)).toBe(before)

    applyCrop()

    expect(store().cropping).toBeNull()
    expect(node(id)).toMatchObject({
      width: 350,
      height: 150,
      crop: { x: 50, y: 50, width: 350, height: 150 },
    })
    expect(node(id).transform).toMatchObject({
      x: before.transform.x + 50,
      y: before.transform.y + 50,
    })
    expect(store().past).toHaveLength(steps + 1)
    store().undo()
    expect(node(id)).toEqual(before)
  })

  it('cancels without a trace, and applying no change records nothing', () => {
    const id = addImage()
    const before = node(id)
    const steps = store().past.length
    startCrop(id)
    cropTopLeft()
    cancelCrop()
    expect(node(id)).toBe(before)

    startCrop(id)
    applyCrop()
    expect(store().past).toHaveLength(steps)
  })

  it('shows the whole image again without leaving crop mode', () => {
    const id = addImage()
    store().updateNodes({ [id]: { crop: { x: 100, y: 0, width: 200, height: 200 } } })
    startCrop(id)
    showWholeImage()
    expect(store().cropping?.box).toEqual(store().cropping?.frame)
    applyCrop()
    expect(node(id).crop).toBeNull()
  })

  it('applies when another tool or page takes over, but not for the hand tool', () => {
    const id = addImage()
    startCrop(id)
    cropTopLeft()
    store().setTool('hand')
    store().setTool('select')
    expect(store().cropping).not.toBeNull()

    store().setTool('brush')
    expect(store().cropping).toBeNull()
    expect(node(id).crop).not.toBeNull()
  })

  it('ends when the image goes away, and opens only on an image that can be picked', () => {
    const id = addImage()
    startCrop(id)
    store().deleteNodes([id])
    expect(store().cropping).toBeNull()

    store().undo()
    store().updateNodes({ [id]: { locked: true } })
    startCrop(id)
    expect(store().cropping).toBeNull()
  })
})
