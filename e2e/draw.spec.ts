import { expect, test, type Page } from '@playwright/test'
import { strFromU8, unzipSync } from 'fflate'
import type Konva from 'konva'
import { readFile } from 'node:fs/promises'
import { readPdf } from './pdf.ts'

const WHITE = [255, 255, 255, 255]
const BLACK = [0, 0, 0, 255]

type Box = { x: number; y: number; width: number; height: number }
type Xy = [number, number]

/** Where the 1600 × 1000 artboard is on the page, at the current zoom and pan. */
function artboardBox(page: Page): Promise<Box> {
  return page.evaluate(() => {
    const stage = (window as unknown as { Konva: typeof Konva }).Konva.stages[0]
    const rect = stage.findOne('.artboard')!.getClientRect()
    const origin = stage.container().getBoundingClientRect()
    return { x: origin.x + rect.x, y: origin.y + rect.y, width: rect.width, height: rect.height }
  })
}

/** The page point over an artboard point given as fractions of its width and height. */
const onArtboard = (box: Box, [fx, fy]: Xy): Xy => [box.x + box.width * fx, box.y + box.height * fy]

/** The export pixel (2× canvas units) under a page point. */
const exportPixelAt = (box: Box, [x, y]: Xy): Xy => [
  Math.round(((x - box.x) / box.width) * 3200),
  Math.round(((y - box.y) / box.height) * 2000),
]

/** Drags the mouse in a straight line between two page points. */
async function drag(page: Page, from: Xy, to: Xy, steps = 12) {
  await page.mouse.move(...from)
  await page.mouse.down()
  for (let i = 1; i <= steps; i++) {
    const t = i / steps
    await page.mouse.move(from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t)
  }
  await page.mouse.up()
}

/** Draws between two artboard points given as fractions of its width and height. */
async function drawLine(page: Page, from: Xy, to: Xy) {
  const box = await artboardBox(page)
  await drag(page, onArtboard(box, from), onArtboard(box, to))
}

/** Ctrl + wheel at a page point; negative deltas zoom in. */
async function wheelZoom(page: Page, at: Xy, deltaY: number, times: number) {
  await page.mouse.move(...at)
  await page.keyboard.down('Control')
  for (let i = 0; i < times; i++) await page.mouse.wheel(0, deltaY)
  await page.keyboard.up('Control')
}

/** Sends a touch pointer event to whatever is at the page point, as a finger would. */
function touch(page: Page, type: 'pointerdown' | 'pointermove' | 'pointerup', id: number, at: Xy) {
  return page.evaluate(
    ({ type, id, at: [x, y] }) => {
      const down = type !== 'pointerup'
      document.elementFromPoint(x, y)!.dispatchEvent(
        new PointerEvent(type, {
          pointerId: id,
          pointerType: 'touch',
          isPrimary: id === 1,
          clientX: x,
          clientY: y,
          pressure: down ? 0.5 : 0,
          buttons: down ? 1 : 0,
          bubbles: true,
          cancelable: true,
        }),
      )
    },
    { type, id, at },
  )
}

/** Number of painted pixels on the content layer (the second of Konva's layer canvases). */
function paintedPixels(page: Page) {
  return page.evaluate(() => {
    const canvas = document.querySelectorAll<HTMLCanvasElement>('[data-testid=canvas] canvas')[1]
    const { data } = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height)
    let count = 0
    for (let i = 3; i < data.length; i += 4) if (data[i] > 0) count++
    return count
  })
}

type SavedDoc = {
  pages: { rootIds: string[] }[]
  nodes: Record<string, { transform: Transform }>
}
type Transform = { x: number; y: number; rotation: number; scaleX: number; scaleY: number }

/** A value the app keeps in IndexedDB: null when there is none, undefined when it can't be read. */
function savedValue(page: Page, key: string) {
  return page.evaluate(
    (key) =>
      new Promise<unknown>((resolve) => {
        const open = indexedDB.open('painter')
        // Never create the database here: the app's own first open has to do that.
        open.onupgradeneeded = () => open.transaction?.abort()
        open.onerror = () => resolve(undefined)
        open.onsuccess = () => {
          const db = open.result
          const request = db.transaction('kv').objectStore('kv').get(key)
          request.onsuccess = () => {
            db.close()
            resolve(request.result ?? null)
          }
          request.onerror = () => {
            db.close()
            resolve(undefined)
          }
        }
      }),
    key,
  )
}

/** The autosaved doc in IndexedDB: null when nothing is saved, undefined when it can't be read. */
const savedDoc = (page: Page) =>
  savedValue(page, 'painter:v3') as Promise<SavedDoc | null | undefined>

/** Number of top-level nodes on the autosaved doc's first page; -1 when it can't be read. */
async function savedNodeCount(page: Page) {
  const doc = await savedDoc(page)
  return doc === undefined ? -1 : (doc?.pages[0].rootIds.length ?? 0)
}

/**
 * The top-level nodes of the autosaved doc's first page, bottom to top; empty when nothing is saved or it
 * can't be read. Autosave lags edits by 500 ms, so a test polls this for the doc it expects,
 * rather than a node count an earlier save may already have. A reload saves pending edits
 * itself, from beforeunload; "a refresh right after drawing…" covers that.
 */
async function savedNodes(page: Page) {
  const doc = await savedDoc(page)
  return doc ? doc.pages[0].rootIds.map((id) => doc.nodes[id]) : []
}

/** The transform of every shape on the content layer, bottom to top, as Konva holds it. */
function shownTransforms(page: Page): Promise<Transform[]> {
  return page.evaluate(() =>
    (window as unknown as { Konva: typeof Konva }).Konva.stages[0]
      .getLayers()[1]
      .getChildren()
      .map((n) => ({
        x: n.x(),
        y: n.y(),
        rotation: n.rotation(),
        scaleX: n.scaleX(),
        scaleY: n.scaleY(),
      })),
  )
}

/** How many nodes the selection Transformer is attached to. */
function selectedCount(page: Page) {
  return page.evaluate(
    () =>
      (window as unknown as { Konva: typeof Konva }).Konva.stages[0]
        .findOne<Konva.Transformer>('Transformer')!
        .nodes().length,
  )
}

/** The page point at the middle of a Transformer handle, such as 'rotater' or 'middle-right'. */
function handleAt(page: Page, name: string): Promise<Xy> {
  return page.evaluate((name) => {
    const stage = (window as unknown as { Konva: typeof Konva }).Konva.stages[0]
    const rect = stage
      .findOne<Konva.Transformer>('Transformer')!
      .findOne(`.${name}`)!
      .getClientRect()
    const origin = stage.container().getBoundingClientRect()
    return [origin.x + rect.x + rect.width / 2, origin.y + rect.y + rect.height / 2] as Xy
  }, name)
}

/** Opens the File menu and picks an item, such as 'Export PNG'. */
async function fromFileMenu(page: Page, item: string) {
  await page.getByRole('button', { name: 'File', exact: true }).click()
  await page.getByRole('menuitem', { name: item }).click()
}

/** Picks File → Export PNG and returns the downloaded file with the RGBA values at the pixels. */
async function exportPixels(page: Page, pixels: [number, number][]) {
  const downloadPromise = page.waitForEvent('download')
  await fromFileMenu(page, 'Export PNG')
  const download = await downloadPromise
  const png = await readFile(await download.path())

  const values = await page.evaluate(
    async ({ dataUrl, pixels }) => {
      const image = new Image()
      image.src = dataUrl
      await image.decode()
      const canvas = document.createElement('canvas')
      canvas.width = image.width
      canvas.height = image.height
      const ctx = canvas.getContext('2d')!
      ctx.drawImage(image, 0, 0)
      return pixels.map(([x, y]) => Array.from(ctx.getImageData(x, y, 1, 1).data))
    },
    { dataUrl: `data:image/png;base64,${png.toString('base64')}`, pixels },
  )
  return { download, png, values }
}

/** Waits until the Stage has mounted its three layer canvases (background, content, overlay). */
async function waitForCanvas(page: Page) {
  await expect(page.locator('[data-testid=canvas] canvas')).toHaveCount(3)
}

// Every test gets a fresh browser context, so localStorage and IndexedDB start empty.
test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await waitForCanvas(page)
})

test('draw, undo, redo, export and reload', async ({ page }) => {
  const undo = page.getByRole('button', { name: 'Undo' })
  const redo = page.getByRole('button', { name: 'Redo' })
  const clear = page.getByRole('button', { name: 'Clear' })

  await expect(undo).toBeDisabled()
  await expect(redo).toBeDisabled()
  await expect.poll(() => paintedPixels(page)).toBe(0)

  await drawLine(page, [0.2, 0.3], [0.8, 0.7])
  await expect(undo).toBeEnabled()
  await expect.poll(() => paintedPixels(page)).toBeGreaterThan(0)
  const painted = await paintedPixels(page)

  await undo.click()
  await expect(undo).toBeDisabled()
  await expect(redo).toBeEnabled()
  await expect.poll(() => paintedPixels(page)).toBe(0)

  await redo.click()
  await expect(undo).toBeEnabled()
  await expect(redo).toBeDisabled()
  await expect.poll(() => paintedPixels(page)).toBe(painted)

  // The background is white and opaque, and the stroke is in the export.
  const { download, png, values } = await exportPixels(page, [
    [2, 2],
    [1600, 1000],
  ])
  expect(download.suggestedFilename()).toBe('painting.png')
  // PNG header: width and height are big-endian at bytes 16 and 20 of the IHDR chunk.
  expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([3200, 2000])
  expect(values).toEqual([WHITE, BLACK])

  // Autosave keeps the drawing across a reload.
  await expect.poll(() => savedNodeCount(page)).toBe(1)
  await page.reload()
  await waitForCanvas(page)
  await expect(clear).toBeEnabled()
  await expect.poll(() => paintedPixels(page)).toBeGreaterThan(0)
})

test('eraser deletes the strokes it touches, as one undo step', async ({ page }) => {
  const redo = page.getByRole('button', { name: 'Redo' })
  // Canvas (800, 300) and (800, 700), doubled in the export.
  const top: [number, number] = [1600, 600]
  const bottom: [number, number] = [1600, 1400]

  await drawLine(page, [0.2, 0.3], [0.8, 0.3])
  await drawLine(page, [0.2, 0.7], [0.8, 0.7])
  await page.keyboard.press('e')
  await expect(page.getByRole('button', { name: 'Eraser' })).toHaveAttribute('aria-pressed', 'true')
  // Crosses the top line only.
  await drawLine(page, [0.5, 0.2], [0.5, 0.4])

  expect((await exportPixels(page, [top, bottom])).values).toEqual([WHITE, BLACK])

  // Keyboard undo brings the whole stroke back, and redo erases it again.
  await page.keyboard.press('Control+z')
  await expect(redo).toBeEnabled()
  expect((await exportPixels(page, [top, bottom])).values).toEqual([BLACK, BLACK])

  await page.keyboard.press('Control+Shift+z')
  await expect(redo).toBeDisabled()
  expect((await exportPixels(page, [top, bottom])).values).toEqual([WHITE, BLACK])
})

test('opens a v1 drawing with its eraser strokes applied', async ({ page }) => {
  const line = Array.from({ length: 97 }, (_, i) => [320 + i * 10, 500, 0.5])
  const eraser = Array.from({ length: 41 }, (_, i) => [800, 300 + i * 10, 0.5])
  const v1 = [
    { id: 'line', tool: 'brush', color: '#000000', size: 8, usesPressure: false, points: line },
    { id: 'cut', tool: 'eraser', color: '#000000', size: 40, usesPressure: false, points: eraser },
  ]
  await page.evaluate((data) => localStorage.setItem('painter:v1', JSON.stringify(data)), v1)
  await page.reload()
  await waitForCanvas(page)

  // Migration is not an undo step, and it is saved as v3 right away.
  await expect(page.getByRole('button', { name: 'Undo' })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Clear' })).toBeEnabled()
  await expect.poll(() => savedNodeCount(page)).toBe(2)

  // Canvas (800, 500) was erased; (500, 500) was not.
  const { values } = await exportPixels(page, [
    [1600, 1000],
    [1000, 1000],
  ])
  expect(values).toEqual([WHITE, BLACK])

  // The pieces are ordinary strokes: one selects, moves and deletes, a step each.
  await page.keyboard.press('v')
  await nextFrame(page)
  await page.mouse.click(...onArtboard(await artboardBox(page), [500 / 1600, 0.5]))
  expect(await selectedCount(page)).toBe(1)
  await page.keyboard.press('ArrowRight')
  expect((await shownTransforms(page))[0]).toMatchObject({ x: 1, y: 0 })
  await page.keyboard.press('Delete')
  expect(await shownTransforms(page)).toHaveLength(1)
  await page.keyboard.press('Control+z')
  await page.keyboard.press('Control+z')
  expect(await shownTransforms(page)).toEqual([
    expect.objectContaining({ x: 0 }),
    expect.objectContaining({ x: 0 }),
  ])
})

test('the PNG is the same at any zoom and pan', async ({ page }) => {
  const zoomLabel = page.getByRole('button', { name: 'Fit page' })
  await drawLine(page, [0.2, 0.3], [0.8, 0.7])
  const fitted = await exportPixels(page, [[1600, 1000]])
  expect(fitted.values).toEqual([BLACK])

  const box = await artboardBox(page)
  await wheelZoom(page, onArtboard(box, [0.7, 0.2]), -100, 6)
  await page.mouse.wheel(120, -80)
  expect((await artboardBox(page)).width).toBeGreaterThan(box.width * 3)
  const zoomedIn = await exportPixels(page, [])
  expect([zoomedIn.png.readUInt32BE(16), zoomedIn.png.readUInt32BE(20)]).toEqual([3200, 2000])
  expect(zoomedIn.png.equals(fitted.png)).toBe(true)

  await wheelZoom(page, onArtboard(box, [0.5, 0.5]), 100, 30)
  await expect(zoomLabel).toHaveText('10%')
  expect((await exportPixels(page, [])).png.equals(fitted.png)).toBe(true)
})

test('strokes land under the pointer at 10% and 3200%', async ({ page }) => {
  const zoomLabel = page.getByRole('button', { name: 'Fit page' })
  // The biggest brush, so a pointer rounded to whole pixels at 10% still lands inside the stroke.
  for (let i = 0; i < 40; i++) await page.keyboard.press(']')
  await expect(page.getByLabel('Brush size')).toHaveValue('64')

  // Zoomed in around one point, drawn a little away from it.
  let box = await artboardBox(page)
  const anchor = onArtboard(box, [0.25, 0.75])
  await wheelZoom(page, anchor, -100, 40)
  await expect(zoomLabel).toHaveText('3200%')
  box = await artboardBox(page)
  const near: Xy = [anchor[0] - 200, anchor[1] + 100]
  await drag(page, near, [near[0] + 40, near[1]])
  const inStroke = exportPixelAt(box, near)
  // 100 canvas units straight up: outside the 64-unit-wide stroke.
  const aboveStroke: Xy = [inStroke[0], inStroke[1] - 200]

  // Zoomed all the way out, drawn somewhere else.
  await wheelZoom(page, near, 100, 60)
  await expect(zoomLabel).toHaveText('10%')
  box = await artboardBox(page)
  const far = onArtboard(box, [0.7, 0.4])
  await drag(page, far, [far[0] + 3, far[1]])
  const inFarStroke = exportPixelAt(box, far)

  const { values } = await exportPixels(page, [inStroke, aboveStroke, inFarStroke])
  expect(values).toEqual([BLACK, WHITE, BLACK])
})

test('Space-drag and the hand tool pan without drawing; Ctrl+0 and Ctrl+1 zoom', async ({
  page,
}) => {
  const undo = page.getByRole('button', { name: 'Undo' })
  const zoomLabel = page.getByRole('button', { name: 'Fit page' })
  const fitted = await artboardBox(page)
  const fittedZoom = (await zoomLabel.textContent())!
  const start = onArtboard(fitted, [0.5, 0.5])

  await page.mouse.move(...start)
  await page.keyboard.down('Space')
  await expect(page.getByRole('button', { name: 'Hand' })).toHaveAttribute('aria-pressed', 'true')
  await drag(page, start, [start[0] + 60, start[1] + 40])
  await page.keyboard.up('Space')
  await expect(page.getByRole('button', { name: 'Brush' })).toHaveAttribute('aria-pressed', 'true')

  const panned = await artboardBox(page)
  expect(panned.x - fitted.x).toBeCloseTo(60, 0)
  expect(panned.y - fitted.y).toBeCloseTo(40, 0)
  expect(panned.width).toBeCloseTo(fitted.width, 3)

  await page.keyboard.press('h')
  await drag(page, start, [start[0] - 60, start[1] - 40])
  const back = await artboardBox(page)
  expect(back.x).toBeCloseTo(fitted.x, 0)
  expect(back.y).toBeCloseTo(fitted.y, 0)
  await expect(undo).toBeDisabled()
  expect(await paintedPixels(page)).toBe(0)

  await page.keyboard.press('Control+1')
  await expect(zoomLabel).toHaveText('100%')
  expect((await artboardBox(page)).width).toBeCloseTo(1600, 3)

  await page.keyboard.press('Control+0')
  await expect(zoomLabel).toHaveText(fittedZoom)
  const refitted = await artboardBox(page)
  expect(refitted.x).toBeCloseTo(fitted.x, 3)
  expect(refitted.y).toBeCloseTo(fitted.y, 3)
  expect(refitted.width).toBeCloseTo(fitted.width, 3)
})

test('a second finger before the first moves 8 px pinches instead of drawing', async ({ page }) => {
  const box = await artboardBox(page)
  const [cx, cy] = onArtboard(box, [0.5, 0.5])

  await touch(page, 'pointerdown', 1, [cx - 40, cy])
  await touch(page, 'pointermove', 1, [cx - 40, cy + 3])
  await touch(page, 'pointerdown', 2, [cx + 40, cy])
  for (let i = 1; i <= 8; i++) {
    const spread = 40 + 5 * i
    await touch(page, 'pointermove', 1, [cx - spread, cy])
    await touch(page, 'pointermove', 2, [cx + spread, cy])
  }
  await touch(page, 'pointerup', 1, [cx - 80, cy])
  await touch(page, 'pointerup', 2, [cx + 80, cy])

  await expect(page.getByRole('button', { name: 'Undo' })).toBeDisabled()
  expect(await paintedPixels(page)).toBe(0)
  // The fingers spread from 80 to 160 px apart.
  expect((await artboardBox(page)).width / box.width).toBeCloseTo(2, 2)
})

test('a second finger after the first has moved is ignored, and the stroke goes on', async ({
  page,
}) => {
  const box = await artboardBox(page)
  const [cx, cy] = onArtboard(box, [0.5, 0.5])

  await touch(page, 'pointerdown', 1, [cx - 100, cy])
  for (let i = 1; i <= 4; i++) await touch(page, 'pointermove', 1, [cx - 100 + 10 * i, cy])
  await touch(page, 'pointerdown', 2, [cx + 100, cy + 50])
  await touch(page, 'pointermove', 2, [cx + 150, cy + 50])
  await touch(page, 'pointermove', 1, [cx + 20, cy])
  await touch(page, 'pointerup', 2, [cx + 150, cy + 50])
  await touch(page, 'pointerup', 1, [cx + 20, cy])

  await expect(page.getByRole('button', { name: 'Undo' })).toBeEnabled()
  expect((await artboardBox(page)).width).toBeCloseTo(box.width, 3)
  // The artboard's middle is on the stroke; canvas (800, 500) is doubled in the export.
  expect((await exportPixels(page, [[1600, 1000]])).values).toEqual([BLACK])
})

/** Where a point in a shape's own coordinates is on the canvas, through the shape's transform. */
function canvasPointOf(page: Page, index: number, local: Xy): Promise<Xy> {
  return page.evaluate(
    ({ index, local: [x, y] }) => {
      const shape = (window as unknown as { Konva: typeof Konva }).Konva.stages[0]
        .getLayers()[1]
        .getChildren()[index]
      const p = shape.getTransform().point({ x, y })
      return [p.x, p.y] as Xy
    },
    { index, local },
  )
}

const doubled = ([x, y]: Xy): Xy => [Math.round(x * 2), Math.round(y * 2)]

/** Waits for Konva's next redraw, which also draws the hit canvas a tool switch turned on. */
const nextFrame = (page: Page) =>
  page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)))

test('a stroke moves, turns and stretches one undo step at a time, and survives a refresh', async ({
  page,
}) => {
  const undo = page.getByRole('button', { name: 'Undo' })
  const redo = page.getByRole('button', { name: 'Redo' })
  // Canvas (480, 500) to (800, 500); its middle is (640, 500) in its own coordinates for good.
  await drawLine(page, [0.3, 0.5], [0.5, 0.5])
  await page.keyboard.press('v')
  await expect(page.getByRole('button', { name: 'Select', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await nextFrame(page)
  const box = await artboardBox(page)
  await page.mouse.click(...onArtboard(box, [0.4, 0.5]))
  await expect.poll(() => selectedCount(page)).toBe(1)

  // Down by 100 canvas units, with Ctrl, which drags without snapping: the ink's right end would
  // snap to the page's center line, 3 px away.
  await page.keyboard.down('Control')
  await drag(page, onArtboard(box, [0.4, 0.5]), onArtboard(box, [0.4, 0.6]))
  await page.keyboard.up('Control')
  let [t] = await shownTransforms(page)
  expect(Math.abs(t.x)).toBeLessThan(2)
  expect(Math.abs(t.y - 100)).toBeLessThan(2)

  // A quarter turn, snapped by Shift: the rotation handle swings from above the middle to its right.
  const middle = onArtboard(box, [0.4, 0.6])
  await page.keyboard.down('Shift')
  await drag(page, await handleAt(page, 'rotater'), [middle[0] + 150, middle[1]])
  await page.keyboard.up('Shift')
  ;[t] = await shownTransforms(page)
  expect(t.rotation).toBe(90)

  // Turned, the stroke's own x axis points down, and so does its middle-right handle.
  const grip = await handleAt(page, 'middle-right')
  await drag(page, grip, [grip[0], grip[1] + 100])
  ;[t] = await shownTransforms(page)
  expect(t.rotation).toBe(90)
  expect(t.scaleX).toBeGreaterThan(1.2)
  expect(t.scaleY).toBe(1)

  // Draw, move, turn and stretch: four undo steps, then nothing.
  for (let i = 0; i < 4; i++) await undo.click()
  await expect(undo).toBeDisabled()
  expect(await shownTransforms(page)).toEqual([])
  for (let i = 0; i < 4; i++) await redo.click()
  await expect(redo).toBeDisabled()
  expect(await shownTransforms(page)).toEqual([t])

  // The middle is still ink; 60 units to the side of the line is not.
  const onLine = doubled(await canvasPointOf(page, 0, [640, 500]))
  const offLine = doubled(await canvasPointOf(page, 0, [640, 440]))
  expect((await exportPixels(page, [onLine, offLine])).values).toEqual([BLACK, WHITE])

  // The transform is saved as is; points are rounded to 0.1 units, so pixels are compared, not files.
  await expect
    .poll(async () => {
      const doc = await savedDoc(page)
      return doc ? Object.values(doc.nodes)[0]?.transform : null
    })
    .toEqual(t)
  await page.reload()
  await waitForCanvas(page)
  expect(await shownTransforms(page)).toEqual([t])
  expect((await exportPixels(page, [onLine, offLine])).values).toEqual([BLACK, WHITE])
})

test('marquee, select all, delete, duplicate, nudge and paste from the keyboard', async ({
  page,
}) => {
  const count = async () => (await shownTransforms(page)).length
  await drawLine(page, [0.2, 0.3], [0.8, 0.3])
  await drawLine(page, [0.2, 0.7], [0.8, 0.7])
  await page.keyboard.press('v')
  await nextFrame(page)
  const box = await artboardBox(page)

  // Only the top line lies fully inside the marquee.
  await drag(page, onArtboard(box, [0.1, 0.2]), onArtboard(box, [0.9, 0.45]))
  expect(await selectedCount(page)).toBe(1)
  await page.keyboard.press('Delete')
  expect(await count()).toBe(1)
  await page.keyboard.press('Control+z')
  expect(await count()).toBe(2)

  await page.keyboard.press('Control+a')
  expect(await selectedCount(page)).toBe(2)
  await page.keyboard.press('Control+d')
  expect(await count()).toBe(4)
  expect(await selectedCount(page)).toBe(2)
  await page.keyboard.press('Control+z')
  expect(await count()).toBe(2)
  expect(await selectedCount(page)).toBe(0)

  // Nudges in quick succession are one undo step.
  await page.mouse.click(...onArtboard(box, [0.5, 0.7]))
  expect(await selectedCount(page)).toBe(1)
  for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowRight')
  await page.keyboard.press('Shift+ArrowDown')
  expect((await shownTransforms(page))[1]).toMatchObject({ x: 5, y: 10 })
  await page.keyboard.press('Control+z')
  expect((await shownTransforms(page))[1]).toMatchObject({ x: 0, y: 0 })

  // A paste lands on top, a little away from the copy, and is selected.
  await page.keyboard.press('Control+c')
  await page.keyboard.press('Control+v')
  expect(await count()).toBe(3)
  expect((await shownTransforms(page))[2]).toMatchObject({ x: 10, y: 10 })
  await page.keyboard.press('Control+Shift+BracketLeft')
  expect((await shownTransforms(page))[0]).toMatchObject({ x: 10, y: 10 })

  await page.keyboard.press('Escape')
  expect(await selectedCount(page)).toBe(0)
})

const RED = [239, 68, 68, 255]
const GREEN = [34, 197, 94, 255]
const BLUE = [59, 130, 246, 255]

/** The export pixel at an artboard point given as fractions of its width and height. */
const exportPixel = ([fx, fy]: Xy): Xy => [Math.round(fx * 3200), Math.round(fy * 2000)]

/** The Konva class of every shape on the content layer, bottom to top. */
function shownShapes(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    (window as unknown as { Konva: typeof Konva }).Konva.stages[0]
      .getLayers()[1]
      .getChildren()
      .map((n) => n.getClassName()),
  )
}

/** A Konva attribute of every shape on the content layer, bottom to top. */
function shownAttr(page: Page, attr: string): Promise<unknown[]> {
  return page.evaluate(
    (attr) =>
      (window as unknown as { Konva: typeof Konva }).Konva.stages[0]
        .getLayers()[1]
        .getChildren()
        .map((n) => n.getAttrs()[attr]),
    attr,
  )
}

/** The page point at the middle of a named overlay shape, such as a line's 'line-end' handle. */
function overlayPointOf(page: Page, name: string): Promise<Xy> {
  return page.evaluate((name) => {
    const stage = (window as unknown as { Konva: typeof Konva }).Konva.stages[0]
    const rect = stage.findOne(`.${name}`)!.getClientRect()
    const origin = stage.container().getBoundingClientRect()
    return [origin.x + rect.x + rect.width / 2, origin.y + rect.y + rect.height / 2] as Xy
  }, name)
}

test('rectangles, ellipses and lines draw, restyle and undo one step at a time', async ({
  page,
}) => {
  const undo = page.getByRole('button', { name: 'Undo' })
  const select = page.getByRole('button', { name: 'Select', exact: true })
  const rectInside = exportPixel([0.2, 0.2])
  const ellipseInside = exportPixel([0.5, 0.2])
  const ellipseCorner = exportPixel([0.41, 0.11]) // inside its box, outside the ellipse
  const onLine = exportPixel([0.4, 0.8])
  // Canvas (940, 807): 7 units beside the line, 20 before its end, inside an arrowhead there.
  const besideTip: Xy = [1880, 1614]

  // A drawn shape is selected, with the select tool, so its style is right there to change.
  await page.getByRole('button', { name: 'Rectangle' }).click()
  await drawLine(page, [0.1, 0.1], [0.3, 0.3])
  await expect(select).toHaveAttribute('aria-pressed', 'true')
  expect(await shownShapes(page)).toEqual(['Rect'])
  expect(await selectedCount(page)).toBe(1)
  // New shapes are outlines without a fill.
  expect((await exportPixels(page, [rectInside])).values).toEqual([WHITE])
  await page.getByRole('button', { name: 'Fill #ef4444' }).click()

  await page.keyboard.press('o')
  await expect(page.getByRole('heading', { name: 'New ellipse' })).toBeVisible()
  await drawLine(page, [0.4, 0.1], [0.6, 0.3])
  await page.getByRole('button', { name: 'Fill #3b82f6' }).click()

  // A line gets a handle on each end instead of the Transformer's box.
  await page.keyboard.press('l')
  await drawLine(page, [0.2, 0.8], [0.6, 0.8])
  expect(await selectedCount(page)).toBe(0)
  await page.getByRole('slider', { name: 'Stroke width' }).focus()
  for (let i = 0; i < 8; i++) await page.keyboard.press('ArrowRight')
  await expect(page.getByRole('group', { name: 'Width' })).toContainText('12')
  await page.getByRole('button', { name: 'Stroke #ef4444' }).click()
  await page.getByRole('button', { name: 'End arrowhead' }).click()
  await expect(page.getByRole('button', { name: 'End arrowhead' })).toHaveAttribute(
    'aria-pressed',
    'true',
  )

  expect(await shownShapes(page)).toEqual(['Rect', 'Ellipse', 'Arrow'])
  expect(
    (await exportPixels(page, [rectInside, ellipseInside, ellipseCorner, onLine, besideTip]))
      .values,
  ).toEqual([RED, BLUE, WHITE, RED, RED])

  // The line: arrowhead, color and the whole slider drag of its width are a step each.
  await undo.click()
  expect((await exportPixels(page, [onLine, besideTip])).values).toEqual([RED, WHITE])
  await undo.click()
  expect((await exportPixels(page, [onLine])).values).toEqual([BLACK])
  await undo.click()
  expect(await shownAttr(page, 'strokeWidth')).toEqual([4, 4, 4])
  await undo.click()
  expect(await shownShapes(page)).toEqual(['Rect', 'Ellipse'])

  // The ellipse and the rectangle: a fill and the shape itself each.
  await undo.click()
  expect((await exportPixels(page, [ellipseInside])).values).toEqual([WHITE])
  await undo.click()
  await undo.click()
  expect((await exportPixels(page, [rectInside])).values).toEqual([WHITE])
  await undo.click()
  await expect(undo).toBeDisabled()
  expect(await shownShapes(page)).toEqual([])
})

test('the properties panel shows mixed values and restyles a whole selection as one step', async ({
  page,
}) => {
  const inside = [exportPixel([0.2, 0.2]), exportPixel([0.5, 0.2])]
  await page.keyboard.press('r')
  await drawLine(page, [0.1, 0.1], [0.3, 0.3])
  await page.getByRole('button', { name: 'Fill #ef4444' }).click()
  await page.keyboard.press('o')
  await drawLine(page, [0.4, 0.1], [0.6, 0.3])
  await page.getByRole('button', { name: 'Fill #3b82f6' }).click()

  await page.keyboard.press('Control+a')
  await expect(page.getByRole('heading', { name: '2 objects' })).toBeVisible()
  const fill = page.getByRole('group', { name: 'Fill', exact: true })
  await expect(fill).toContainText('Mixed')
  await page.getByRole('button', { name: 'Fill #22c55e' }).click()
  await expect(fill).not.toContainText('Mixed')
  expect((await exportPixels(page, inside)).values).toEqual([GREEN, GREEN])

  // Moving a slider step by step is one undo step too.
  await page.getByRole('slider', { name: 'Stroke width' }).focus()
  for (let i = 0; i < 10; i++) await page.keyboard.press('ArrowRight')
  expect(await shownAttr(page, 'strokeWidth')).toEqual([14, 14])

  await page.keyboard.press('Control+z')
  expect(await shownAttr(page, 'strokeWidth')).toEqual([4, 4])
  await page.keyboard.press('Control+z')
  expect((await exportPixels(page, inside)).values).toEqual([RED, BLUE])

  // Shapes are saved and come back after a reload; the undone fill and width were saved too.
  await expect
    .poll(() => savedNodes(page))
    .toMatchObject([
      { type: 'rect', style: { fill: { kind: 'solid', color: '#ef4444' }, strokeWidth: 4 } },
      { type: 'ellipse', style: { fill: { kind: 'solid', color: '#3b82f6' }, strokeWidth: 4 } },
    ])
  await page.reload()
  await waitForCanvas(page)
  expect(await shownShapes(page)).toEqual(['Rect', 'Ellipse'])
  expect((await exportPixels(page, inside)).values).toEqual([RED, BLUE])
})

test('a refresh right after drawing keeps the drawing, though autosave waits 500 ms', async ({
  page,
}) => {
  await page.keyboard.press('r')
  await drawLine(page, [0.1, 0.1], [0.3, 0.3])

  // Reloads at once, inside autosave's wait, so only the save before unload can keep the rectangle.
  await page.reload()
  await waitForCanvas(page)
  expect(await shownShapes(page)).toEqual(['Rect'])
  expect(await savedNodes(page)).toMatchObject([{ type: 'rect' }])
})

test('duplicate, delete and z-order have buttons for touch screens', async ({ page }) => {
  await page.keyboard.press('r')
  await drawLine(page, [0.1, 0.1], [0.3, 0.3])
  await page.keyboard.press('o')
  await drawLine(page, [0.2, 0.2], [0.4, 0.4])

  await page.getByRole('button', { name: 'Send to back' }).click()
  expect(await shownShapes(page)).toEqual(['Ellipse', 'Rect'])
  await page.getByRole('button', { name: 'Bring forward' }).click()
  expect(await shownShapes(page)).toEqual(['Rect', 'Ellipse'])
  await page.getByRole('button', { name: 'Duplicate', exact: true }).click()
  expect(await shownShapes(page)).toEqual(['Rect', 'Ellipse', 'Ellipse'])
  await page.getByRole('button', { name: 'Delete', exact: true }).click()
  expect(await shownShapes(page)).toEqual(['Rect', 'Ellipse'])
  await expect(page.getByRole('heading', { name: 'Nothing selected' })).toBeVisible()

  // Delete, duplicate and bring forward, then send to back.
  for (let i = 0; i < 3; i++) await page.keyboard.press('Control+z')
  expect(await shownShapes(page)).toEqual(['Ellipse', 'Rect'])
  await page.keyboard.press('Control+z')
  expect(await shownShapes(page)).toEqual(['Rect', 'Ellipse'])
})

test('a line end drags and snaps to 45° with Shift, as one undo step', async ({ page }) => {
  await page.keyboard.press('l')
  // Canvas (320, 500) to (640, 500).
  await drawLine(page, [0.2, 0.5], [0.4, 0.5])
  const box = await artboardBox(page)
  const end = await overlayPointOf(page, 'line-end')

  await page.keyboard.down('Shift')
  await drag(page, end, onArtboard(box, [0.35, 0.25]))
  await page.keyboard.up('Shift')

  const [[x1, y1, x2, y2]] = (await shownAttr(page, 'points')) as number[][]
  expect(x2 - x1).toBeCloseTo(-(y2 - y1), 6)
  expect(y2 - y1).toBeLessThan(-100)

  await page.keyboard.press('Control+z')
  const [points] = (await shownAttr(page, 'points')) as number[][]
  expect(Math.abs(points[3] - points[1])).toBeLessThan(2)
  await expect(page.getByRole('button', { name: 'Undo' })).toBeEnabled()
})

/** A one-finger drag between two page points. */
async function touchDrag(page: Page, from: Xy, to: Xy, steps = 8) {
  await touch(page, 'pointerdown', 1, from)
  for (let i = 1; i <= steps; i++) {
    const t = i / steps
    await touch(page, 'pointermove', 1, [
      from[0] + (to[0] - from[0]) * t,
      from[1] + (to[1] - from[1]) * t,
    ])
  }
  await touch(page, 'pointerup', 1, to)
}

test.describe('on a 375 px phone', () => {
  test.use({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true })

  test('each shape draws by touch, restyles and undoes, with the panel as a bottom sheet', async ({
    page,
  }) => {
    const undo = page.getByRole('button', { name: 'Undo' })
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(375)
    const canvas = (await page.getByTestId('canvas').boundingBox())!
    const panel = (await page.getByRole('complementary', { name: 'Properties' }).boundingBox())!
    expect(panel.y).toBeGreaterThanOrEqual(canvas.y + canvas.height - 1)
    expect(panel.width).toBe(375)

    const shapes = [
      { tool: 'Rectangle', from: [0.1, 0.2], to: [0.3, 0.6], color: 'Fill #22c55e' },
      { tool: 'Ellipse', from: [0.4, 0.2], to: [0.6, 0.6], color: 'Fill #22c55e' },
      { tool: 'Line', from: [0.1, 0.8], to: [0.6, 0.8], color: 'Stroke #22c55e' },
    ] satisfies { tool: string; from: Xy; to: Xy; color: string }[]
    for (const { tool, from, to, color } of shapes) {
      await page.getByRole('button', { name: tool, exact: true }).tap()
      const box = await artboardBox(page)
      await touchDrag(page, onArtboard(box, from), onArtboard(box, to))
      await expect(page.getByRole('button', { name: 'Select', exact: true })).toHaveAttribute(
        'aria-pressed',
        'true',
      )
      await page.getByRole('button', { name: color }).tap()
    }

    expect(await shownShapes(page)).toEqual(['Rect', 'Ellipse', 'Arrow'])
    expect(await shownAttr(page, 'stroke')).toEqual(['#000000', '#000000', '#22c55e'])
    const inside = [exportPixel([0.2, 0.4]), exportPixel([0.5, 0.4])]
    expect((await exportPixels(page, inside)).values).toEqual([GREEN, GREEN])

    // A shape and its color are two steps each.
    await undo.tap()
    expect(await shownAttr(page, 'stroke')).toEqual(['#000000', '#000000', '#000000'])
    for (let i = 0; i < 3; i++) await undo.tap()
    expect((await exportPixels(page, inside)).values).toEqual([GREEN, WHITE])
    for (let i = 0; i < 2; i++) await undo.tap()
    await expect(undo).toBeDisabled()
    expect(await shownShapes(page)).toEqual([])
  })
})

/** How many anchors direct select shows on the overlay. */
function anchorCount(page: Page) {
  return page.evaluate(
    () =>
      (window as unknown as { Konva: typeof Konva }).Konva.stages[0].find((n: Konva.Node) =>
        /^anchor-\d+-\d+$/.test(n.name()),
      ).length,
  )
}

test('the pen draws a closed heart that reshapes by its handles, one undo step each', async ({
  page,
}) => {
  const undo = page.getByRole('button', { name: 'Undo' })
  const inside = exportPixel([0.5, 0.55])
  // Canvas (549, 250): above the left lobe, until its out handle is pulled up.
  const aboveLobe: Xy = [1098, 500]

  // Bottom tip, left lobe dragged up, top dip, right lobe dragged down, then the tip again.
  await page.keyboard.press('p')
  const box = await artboardBox(page)
  await page.mouse.click(...onArtboard(box, [0.5, 0.8]))
  await drag(page, onArtboard(box, [0.3, 0.4]), onArtboard(box, [0.3, 0.2]))
  await page.mouse.click(...onArtboard(box, [0.5, 0.35]))
  await drag(page, onArtboard(box, [0.7, 0.4]), onArtboard(box, [0.7, 0.6]))
  await expect(page.getByRole('button', { name: 'Finish path' })).toBeEnabled()
  await page.mouse.click(...onArtboard(box, [0.5, 0.8]))

  // The closed path is selected, with the select tool.
  await expect(page.getByRole('button', { name: 'Select', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  expect(await shownShapes(page)).toEqual(['Path'])
  expect(await selectedCount(page)).toBe(1)
  expect(await shownAttr(page, 'data')).toEqual([expect.stringMatching(/ Z$/)])
  await page.getByRole('button', { name: 'Fill #ef4444' }).click()
  expect((await exportPixels(page, [inside, aboveLobe])).values).toEqual([RED, WHITE])

  // A double-click on the path switches to direct select, with its 4 anchors.
  await page.mouse.dblclick(...onArtboard(box, [0.5, 0.55]))
  await expect(page.getByRole('button', { name: 'Direct select' })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await expect.poll(() => anchorCount(page)).toBe(4)
  const [heart] = (await shownAttr(page, 'data')) as string[]

  // Pulling the left lobe's handle up makes the lobe taller.
  await drag(page, await overlayPointOf(page, 'handle-out-0-1'), onArtboard(box, [0.3, 0]))
  expect((await exportPixels(page, [aboveLobe])).values).toEqual([RED])
  const [taller] = (await shownAttr(page, 'data')) as string[]

  // Alt-drag moves one handle of the smooth right lobe and leaves the other alone.
  const otherHandle = await overlayPointOf(page, 'handle-in-0-3')
  await page.keyboard.down('Alt')
  await drag(page, await overlayPointOf(page, 'handle-out-0-3'), onArtboard(box, [0.8, 0.6]))
  await page.keyboard.up('Alt')
  expect(await overlayPointOf(page, 'handle-in-0-3')).toEqual(otherHandle)
  await expect(page.getByRole('button', { name: 'Corner' })).toHaveAttribute('aria-pressed', 'true')

  // Alt-drag, drag, fill and the path itself: a step each.
  await undo.click()
  expect(await shownAttr(page, 'data')).toEqual([taller])
  await undo.click()
  expect(await shownAttr(page, 'data')).toEqual([heart])
  expect((await exportPixels(page, [aboveLobe])).values).toEqual([WHITE])
  await undo.click()
  expect((await exportPixels(page, [inside])).values).toEqual([WHITE])
  await undo.click()
  await expect(undo).toBeDisabled()
  expect(await shownShapes(page)).toEqual([])
})

test('a rectangle converts to a path whose anchors add and delete, one undo step each', async ({
  page,
}) => {
  const undo = page.getByRole('button', { name: 'Undo' })
  // Inside, on the left side's outline and outside the rectangle from canvas (320, 200) to
  // (640, 500).
  const pixels = [exportPixel([0.3, 0.35]), exportPixel([0.2, 0.35]), exportPixel([0.15, 0.35])]

  await page.keyboard.press('r')
  await drawLine(page, [0.2, 0.2], [0.4, 0.5])
  await page.getByRole('button', { name: 'Fill #3b82f6' }).click()
  expect((await exportPixels(page, pixels)).values).toEqual([BLUE, BLACK, WHITE])

  await page.getByRole('button', { name: 'Convert to path' }).click()
  expect(await shownShapes(page)).toEqual(['Path'])
  await expect(page.getByRole('heading', { name: 'Path' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Convert to path' })).toHaveCount(0)
  expect((await exportPixels(page, pixels)).values).toEqual([BLUE, BLACK, WHITE])

  // A double-click on the top side adds an anchor, and Delete removes it again.
  await page.keyboard.press('a')
  await expect.poll(() => anchorCount(page)).toBe(4)
  const box = await artboardBox(page)
  await page.mouse.dblclick(...onArtboard(box, [0.3, 0.2]))
  expect(await anchorCount(page)).toBe(5)
  await expect(page.getByRole('group', { name: 'Anchor kind' })).toBeVisible()
  await page.keyboard.press('Delete')
  expect(await anchorCount(page)).toBe(4)

  // Delete, add and convert are a step each.
  await undo.click()
  expect(await anchorCount(page)).toBe(5)
  await undo.click()
  expect(await anchorCount(page)).toBe(4)
  await undo.click()
  expect(await shownShapes(page)).toEqual(['Rect'])
  expect((await exportPixels(page, pixels)).values).toEqual([BLUE, BLACK, WHITE])
})

test('paths are saved and come back after a reload', async ({ page }) => {
  await page.keyboard.press('p')
  const box = await artboardBox(page)
  await page.mouse.click(...onArtboard(box, [0.2, 0.2]))
  await drag(page, onArtboard(box, [0.4, 0.6]), onArtboard(box, [0.5, 0.6]))
  await page.keyboard.press('Enter')
  const drawn = await shownAttr(page, 'data')

  await expect.poll(() => savedNodeCount(page)).toBe(1)
  await page.reload()
  await waitForCanvas(page)
  expect(await shownShapes(page)).toEqual(['Path'])
  expect(await shownAttr(page, 'data')).toEqual(drawn)
})

/** Real touch events through the DevTools protocol: Konva's own drags follow these. */
async function fingerOn(page: Page) {
  const cdp = await page.context().newCDPSession(page)
  const send = (type: 'touchStart' | 'touchMove' | 'touchEnd', at?: Xy) =>
    cdp.send('Input.dispatchTouchEvent', {
      type,
      touchPoints: at ? [{ x: at[0], y: at[1] }] : [],
    })
  const drag = async (from: Xy, to: Xy, steps = 8) => {
    await send('touchStart', from)
    for (let i = 1; i <= steps; i++) {
      const t = i / steps
      await send('touchMove', [from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t])
    }
    // A finger holds still before it lifts; a fast release would start a fling in Chrome,
    // and the next tap would only stop it.
    await page.waitForTimeout(150)
    await send('touchEnd')
  }
  return { drag, tap: (at: Xy) => drag(at, at, 0) }
}

test.describe('paths on a 375 px phone', () => {
  test.use({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true })

  test('the pen, direct select and convert to path work by touch, and undo', async ({ page }) => {
    const finger = await fingerOn(page)
    const undo = page.getByRole('button', { name: 'Undo' })
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(375)

    // A corner, a smooth anchor dragged out to the right, and a corner; the panel ends the path.
    await page.getByRole('button', { name: 'Pen' }).tap()
    const box = await artboardBox(page)
    await finger.tap(onArtboard(box, [0.2, 0.3]))
    await finger.drag(onArtboard(box, [0.4, 0.7]), onArtboard(box, [0.5, 0.7]))
    await finger.tap(onArtboard(box, [0.6, 0.3]))
    await page.getByRole('button', { name: 'Finish path' }).tap()
    await expect(page.getByRole('button', { name: 'Select', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    expect(await shownShapes(page)).toEqual(['Path'])
    const drawn = await shownAttr(page, 'data')

    // The path stays selected; direct select shows its anchors, and a handle drags by touch.
    await page.getByRole('button', { name: 'Direct select' }).tap()
    await expect.poll(() => anchorCount(page)).toBe(3)
    const handle = await overlayPointOf(page, 'handle-out-0-1')
    const twin = await overlayPointOf(page, 'handle-in-0-1')
    await finger.drag(handle, [handle[0], handle[1] + 60])
    expect(await shownAttr(page, 'data')).not.toEqual(drawn)
    // The smooth anchor's other handle swings to stay in line.
    expect(await overlayPointOf(page, 'handle-in-0-1')).not.toEqual(twin)

    // A rectangle converts with a tap.
    await page.getByRole('button', { name: 'Rectangle' }).tap()
    await finger.drag(onArtboard(box, [0.1, 0.75]), onArtboard(box, [0.3, 0.95]))
    await page.getByRole('button', { name: 'Convert to path' }).tap()
    expect(await shownShapes(page)).toEqual(['Path', 'Path'])

    // Convert, rectangle, handle drag and the path: a step each.
    await undo.tap()
    expect(await shownShapes(page)).toEqual(['Path', 'Rect'])
    await undo.tap()
    await undo.tap()
    expect(await shownAttr(page, 'data')).toEqual(drawn)
    await undo.tap()
    await expect(undo).toBeDisabled()
    expect(await shownShapes(page)).toEqual([])
  })
})

/** The Konva class and x of every shape inside the group at `index` on the content layer. */
function groupChildren(page: Page, index = 0): Promise<{ type: string; x: number }[]> {
  return page.evaluate((index) => {
    const group = (window as unknown as { Konva: typeof Konva }).Konva.stages[0]
      .getLayers()[1]
      .getChildren()[index] as Konva.Group
    return group.getChildren().map((n) => ({ type: n.getClassName(), x: n.x() }))
  }, index)
}

/** The text of every Text on the content layer, bottom to top. */
const shownTexts = async (page: Page) => (await shownAttr(page, 'text')).filter(Boolean)

test('a text is placed, typed and edited, one undo step per edit', async ({ page }) => {
  const undo = page.getByRole('button', { name: 'Undo' })
  const redo = page.getByRole('button', { name: 'Redo' })
  const editor = page.getByRole('textbox', { name: 'Text' })
  const select = page.getByRole('button', { name: 'Select', exact: true })

  await page.keyboard.press('t')
  await expect(page.getByRole('heading', { name: 'New text' })).toBeVisible()
  const box = await artboardBox(page)
  await page.mouse.click(...onArtboard(box, [0.3, 0.3]))
  await expect(editor).toBeFocused()
  // Letters that are tool shortcuts go into the text, not to the canvas.
  await page.keyboard.type('Hello, world')
  await page.keyboard.press('Control+Enter')
  await expect(editor).toHaveCount(0)

  // The text is selected, with the select tool; typing it was one step.
  await expect(select).toHaveAttribute('aria-pressed', 'true')
  expect(await shownShapes(page)).toEqual(['Text'])
  expect(await shownTexts(page)).toEqual(['Hello, world'])
  expect(await selectedCount(page)).toBe(1)
  await undo.click()
  expect(await shownShapes(page)).toEqual([])
  await expect(undo).toBeDisabled()
  await redo.click()
  expect(await shownTexts(page)).toEqual(['Hello, world'])
  // Konva draws the restored text's hit area on its next frame.
  await nextFrame(page)

  // A double-click opens it again; Esc puts it back as it was.
  const onText = onArtboard(box, [0.32, 0.3])
  await page.mouse.dblclick(...onText)
  await expect(editor).toHaveValue('Hello, world')
  await page.keyboard.press('Control+a')
  await page.keyboard.type('Gone')
  await page.keyboard.press('Escape')
  await expect(editor).toHaveCount(0)
  expect(await shownTexts(page)).toEqual(['Hello, world'])
  // The text was hidden while edited; Konva draws its hit area again on its next frame.
  await nextFrame(page)

  // A click on the canvas ends an edit; emptying a text deletes it, one step.
  await page.mouse.dblclick(...onText)
  await page.keyboard.press('End')
  await page.keyboard.type('!')
  await page.mouse.click(...onArtboard(box, [0.8, 0.8]))
  await expect(editor).toHaveCount(0)
  expect(await shownTexts(page)).toEqual(['Hello, world!'])
  await page.keyboard.press('Enter')
  await page.keyboard.press('Control+a')
  await page.keyboard.press('Delete')
  await page.keyboard.press('Control+Enter')
  expect(await shownShapes(page)).toEqual([])
  await undo.click()
  expect(await shownTexts(page)).toEqual(['Hello, world!'])
  await undo.click()
  expect(await shownTexts(page)).toEqual(['Hello, world'])

  // Text is saved and comes back after a reload, as the undos left it.
  await expect.poll(() => savedNodes(page)).toMatchObject([{ type: 'text', text: 'Hello, world' }])
  await page.reload()
  await waitForCanvas(page)
  expect(await shownTexts(page)).toEqual(['Hello, world'])
  expect(await paintedPixels(page)).toBeGreaterThan(0)
})

test('groups, a group entered by double-click, and ungroup, one undo step each', async ({
  page,
}) => {
  const undo = page.getByRole('button', { name: 'Undo' })
  await page.keyboard.press('r')
  await drawLine(page, [0.1, 0.1], [0.3, 0.3])
  await page.getByRole('button', { name: 'Fill #ef4444' }).click()
  await page.keyboard.press('o')
  await drawLine(page, [0.5, 0.1], [0.7, 0.3])
  await page.getByRole('button', { name: 'Fill #3b82f6' }).click()

  await page.keyboard.press('Control+a')
  await page.keyboard.press('Control+g')
  expect(await shownShapes(page)).toEqual(['Group'])
  await expect(page.getByRole('heading', { name: 'Group' })).toBeVisible()
  const [rect, ellipse] = await groupChildren(page)

  // A click on a child picks the group; a double-click goes in and picks the child.
  const box = await artboardBox(page)
  await page.keyboard.press('Escape')
  await page.mouse.click(...onArtboard(box, [0.6, 0.2]))
  await expect(page.getByRole('heading', { name: 'Group' })).toBeVisible()
  await page.mouse.dblclick(...onArtboard(box, [0.6, 0.2]))
  await expect(page.getByRole('heading', { name: 'Ellipse' })).toBeVisible()

  // Inside, a drag moves only the child.
  await drag(page, onArtboard(box, [0.6, 0.2]), onArtboard(box, [0.6 + 0.1, 0.2]))
  const moved = await groupChildren(page)
  expect(Math.abs(moved[1].x - ellipse.x - 160)).toBeLessThan(2)
  expect(moved[0].x).toBe(rect.x)
  expect((await exportPixels(page, [exportPixel([0.7, 0.2])])).values).toEqual([BLUE])

  // Esc goes back out to the group, and Ctrl+Shift+G ungroups it in place.
  await page.keyboard.press('Escape')
  await expect(page.getByRole('heading', { name: 'Group' })).toBeVisible()
  await page.keyboard.press('Control+Shift+g')
  expect(await shownShapes(page)).toEqual(['Rect', 'Ellipse'])
  await expect(page.getByRole('heading', { name: '2 objects' })).toBeVisible()
  expect(
    (await exportPixels(page, [exportPixel([0.2, 0.2]), exportPixel([0.7, 0.2])])).values,
  ).toEqual([RED, BLUE])

  // Ungroup, move and group: a step each.
  await undo.click()
  expect(await shownShapes(page)).toEqual(['Group'])
  await undo.click()
  expect((await groupChildren(page))[1].x).toBe(ellipse.x)
  await undo.click()
  expect(await shownShapes(page)).toEqual(['Rect', 'Ellipse'])
})

test('layers hide, lock, rename and reorder; hidden and locked objects are not picked', async ({
  page,
}) => {
  const undo = page.getByRole('button', { name: 'Undo' })
  const layers = page.getByRole('complementary', { name: 'Layers' })
  const nothing = page.getByRole('heading', { name: 'Nothing selected' })
  const rectInside = exportPixel([0.2, 0.2])
  const ellipseInside = exportPixel([0.6, 0.2])

  await page.keyboard.press('r')
  await drawLine(page, [0.1, 0.1], [0.3, 0.3])
  await page.getByRole('button', { name: 'Fill #ef4444' }).click()
  await page.keyboard.press('o')
  await drawLine(page, [0.5, 0.1], [0.7, 0.3])
  await page.getByRole('button', { name: 'Fill #3b82f6' }).click()
  // Front-most on top.
  await expect(layers.getByRole('treeitem')).toHaveText(['Ellipse', 'Rectangle'])

  // Hidden: not drawn, not picked, not selected by the marquee or Ctrl+A.
  await layers.getByRole('button', { name: 'Hide Rectangle' }).click()
  expect((await exportPixels(page, [rectInside])).values).toEqual([WHITE])
  const box = await artboardBox(page)
  await page.mouse.click(...onArtboard(box, [0.2, 0.2]))
  await expect(nothing).toBeVisible()
  await drag(page, onArtboard(box, [0.05, 0.05]), onArtboard(box, [0.9, 0.5]))
  expect(await selectedCount(page)).toBe(1)
  await page.keyboard.press('Control+a')
  await expect(page.getByRole('heading', { name: 'Ellipse' })).toBeVisible()
  await layers.getByRole('button', { name: 'Show Rectangle' }).click()
  expect((await exportPixels(page, [rectInside])).values).toEqual([RED])

  // Locked: drawn, but not picked, moved or erased.
  await layers.getByRole('button', { name: 'Lock Ellipse' }).click()
  await expect(nothing).toBeVisible()
  await page.mouse.click(...onArtboard(box, [0.6, 0.2]))
  await expect(nothing).toBeVisible()
  await drag(page, onArtboard(box, [0.6, 0.2]), onArtboard(box, [0.6, 0.5]))
  await page.keyboard.press('e')
  await drawLine(page, [0.55, 0.05], [0.65, 0.35])
  expect((await exportPixels(page, [ellipseInside])).values).toEqual([BLUE])
  await page.keyboard.press('v')

  // A double-click on a name renames the layer, one step.
  await layers.getByRole('button', { name: 'Rectangle', exact: true }).dblclick()
  await layers.getByRole('textbox', { name: 'Layer name' }).fill('Door')
  await page.keyboard.press('Enter')
  await expect(layers.getByRole('treeitem')).toHaveText(['Ellipse', 'Door'])

  // Dragging a row above another brings it in front.
  const door = (await layers.getByRole('treeitem', { name: 'Door' }).boundingBox())!
  const top = (await layers.getByRole('treeitem', { name: 'Ellipse' }).boundingBox())!
  await drag(
    page,
    [door.x + door.width / 2, door.y + door.height / 2],
    [top.x + top.width / 2, top.y + 4],
  )
  await expect(layers.getByRole('treeitem')).toHaveText(['Door', 'Ellipse'])
  expect(await shownShapes(page)).toEqual(['Ellipse', 'Rect'])

  // Reorder, rename, lock, show and hide: a step each.
  await undo.click()
  expect(await shownShapes(page)).toEqual(['Rect', 'Ellipse'])
  await undo.click()
  await expect(layers.getByRole('treeitem')).toHaveText(['Ellipse', 'Rectangle'])
  await undo.click()
  await expect(layers.getByRole('button', { name: 'Lock Ellipse' })).toBeVisible()
  await undo.click()
  await undo.click()
  await expect(layers.getByRole('button', { name: 'Hide Rectangle' })).toBeVisible()
})

test.describe('text, groups and layers on a 375 px phone', () => {
  test.use({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true })

  test('place a text, group, hide and reorder by touch, and undo', async ({ page }) => {
    const finger = await fingerOn(page)
    const undo = page.getByRole('button', { name: 'Undo' })
    const layers = page.getByRole('complementary', { name: 'Layers' })
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(375)
    // The ten tools fit one row.
    const first = (await page.getByRole('button', { name: 'Select', exact: true }).boundingBox())!
    const last = (await page.getByRole('button', { name: 'Hand' }).boundingBox())!
    expect(last.y).toBe(first.y)

    // A tap places a text, the keyboard types it, and a tap on the canvas ends it.
    await page.getByRole('button', { name: 'Text', exact: true }).tap()
    const box = await artboardBox(page)
    await finger.tap(onArtboard(box, [0.2, 0.3]))
    await expect(page.getByRole('textbox', { name: 'Text' })).toBeFocused()
    await page.keyboard.type('Hi')
    await finger.tap(onArtboard(box, [0.8, 0.9]))
    await expect(page.getByRole('textbox', { name: 'Text' })).toHaveCount(0)
    expect(await shownTexts(page)).toEqual(['Hi'])

    // A rectangle, then both selected by a marquee and grouped from the panel.
    await page.getByRole('button', { name: 'Rectangle' }).tap()
    await finger.drag(onArtboard(box, [0.5, 0.5]), onArtboard(box, [0.7, 0.8]))
    await page.getByRole('button', { name: 'Fill #22c55e' }).tap()
    await finger.drag(onArtboard(box, [0.02, 0.02]), onArtboard(box, [0.98, 0.98]))
    await expect(page.getByRole('heading', { name: '2 objects' })).toBeVisible()
    await page.getByRole('button', { name: 'Group', exact: true }).tap()
    expect(await shownShapes(page)).toEqual(['Group'])

    // The layers tab: the group opens to its children; hide one, rename the group.
    await page.getByRole('tab', { name: 'Layers' }).tap()
    await expect(layers.getByRole('treeitem')).toHaveText(['Group', 'Rectangle', 'Text'])
    await layers.getByRole('button', { name: 'Hide Rectangle' }).tap()
    expect((await exportPixels(page, [exportPixel([0.6, 0.65])])).values).toEqual([WHITE])
    await layers.getByRole('button', { name: 'Group', exact: true }).tap()
    await layers.getByRole('button', { name: 'Group', exact: true }).tap()
    await layers.getByRole('textbox', { name: 'Layer name' }).fill('Sign')
    await page.keyboard.press('Enter')
    await expect(layers.getByRole('treeitem', { name: 'Sign' })).toBeVisible()

    // A finger drags a row by its grip: the text goes in front of the rectangle.
    const grip = async (name: string): Promise<Xy> => {
      const handle = layers.getByRole('treeitem', { name }).locator('[data-grip]')
      const { x, y, width, height } = (await handle.boundingBox())!
      return [x + width / 2, y + height / 2]
    }
    const [x, y] = await grip('Text')
    const rect = await grip('Rectangle')
    await finger.drag([x, y], [x, rect[1] - 12])
    await expect(layers.getByRole('treeitem')).toHaveText(['Sign', 'Text', 'Rectangle'])

    // Reorder, rename, hide and group: a step each.
    await undo.tap()
    await expect(layers.getByRole('treeitem')).toHaveText(['Sign', 'Rectangle', 'Text'])
    await undo.tap()
    await undo.tap()
    expect((await exportPixels(page, [exportPixel([0.6, 0.65])])).values).toEqual([GREEN])
    await undo.tap()
    expect(await shownShapes(page)).toEqual(['Text', 'Rect'])
  })
})

/** Picks a File menu item that opens a file picker, and hands the picker a file. */
async function chooseFromFileMenu(page: Page, item: string, name: string, text: string) {
  const chooser = page.waitForEvent('filechooser')
  await fromFileMenu(page, item)
  await (await chooser).setFiles({ name, mimeType: 'text/plain', buffer: Buffer.from(text) })
}

/** Picks a File menu item that downloads a file; returns its suggested name and its text. */
async function downloadFromFileMenu(page: Page, item: string) {
  const downloadPromise = page.waitForEvent('download')
  await fromFileMenu(page, item)
  const download = await downloadPromise
  return { name: download.suggestedFilename(), text: await readFile(await download.path(), 'utf8') }
}

/** Picks a File menu item that downloads a file; returns its suggested name and its bytes. */
async function downloadBytesFromFileMenu(page: Page, item: string) {
  const downloadPromise = page.waitForEvent('download')
  await fromFileMenu(page, item)
  const download = await downloadPromise
  return { name: download.suggestedFilename(), bytes: await readFile(await download.path()) }
}

/** The doc.json of a .painter file, parsed, and the names of the other files in it. */
function readPainter(bytes: Uint8Array) {
  const entries = unzipSync(bytes)
  const others = Object.keys(entries).filter((name) => name !== 'doc.json')
  return { doc: JSON.parse(strFromU8(entries['doc.json'])), others, entries }
}

/**
 * Draws the SVG at the PNG export's size, 3200 × 2000, and counts the pixels that differ from the
 * PNG: `some` by more than 16 of 255 in a channel, as anti-aliased edges may, `far` by more than 96.
 */
function svgAgainstPng(page: Page, svg: string, png: Buffer) {
  return page.evaluate(
    async ({ svgUrl, pngUrl }) => {
      const pixels = async (url: string) => {
        const image = new Image()
        image.src = url
        await image.decode()
        const canvas = document.createElement('canvas')
        canvas.width = 3200
        canvas.height = 2000
        const ctx = canvas.getContext('2d')!
        ctx.drawImage(image, 0, 0, 3200, 2000)
        return ctx.getImageData(0, 0, 3200, 2000).data
      }
      const a = await pixels(pngUrl)
      const b = await pixels(svgUrl)
      let some = 0
      let far = 0
      for (let i = 0; i < a.length; i += 4) {
        const d = Math.max(
          Math.abs(a[i] - b[i]),
          Math.abs(a[i + 1] - b[i + 1]),
          Math.abs(a[i + 2] - b[i + 2]),
        )
        if (d > 16) some++
        if (d > 96) far++
      }
      return { some, far }
    },
    {
      svgUrl: `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`,
      pngUrl: `data:image/png;base64,${png.toString('base64')}`,
    },
  )
}

test('the SVG export matches the PNG, and imports back as one group in one undo step', async ({
  page,
}) => {
  const undo = page.getByRole('button', { name: 'Undo' })
  const box = await artboardBox(page)

  // A brush stroke, a red rectangle, a blue ellipse, an arrow, a green pen triangle and a text.
  await drawLine(page, [0.1, 0.6], [0.4, 0.9])
  await page.getByRole('button', { name: 'Rectangle' }).click()
  await drawLine(page, [0.1, 0.1], [0.3, 0.3])
  await page.getByRole('button', { name: 'Fill #ef4444' }).click()
  await page.keyboard.press('o')
  await drawLine(page, [0.4, 0.1], [0.6, 0.3])
  await page.getByRole('button', { name: 'Fill #3b82f6' }).click()
  await page.keyboard.press('l')
  await drawLine(page, [0.5, 0.6], [0.9, 0.6])
  await page.getByRole('button', { name: 'End arrowhead' }).click()
  await page.keyboard.press('p')
  await page.mouse.click(...onArtboard(box, [0.7, 0.1]))
  await page.mouse.click(...onArtboard(box, [0.9, 0.2]))
  await drag(page, onArtboard(box, [0.8, 0.4]), onArtboard(box, [0.75, 0.45]))
  await page.mouse.click(...onArtboard(box, [0.7, 0.1]))
  await page.getByRole('button', { name: 'Fill #22c55e' }).click()
  await page.keyboard.press('t')
  await page.mouse.click(...onArtboard(box, [0.55, 0.75]))
  await page.keyboard.type('Hello SVG')
  await page.keyboard.press('Control+Enter')
  expect(await shownShapes(page)).toEqual(['Path', 'Rect', 'Ellipse', 'Arrow', 'Path', 'Text'])

  const { name, text: svg } = await downloadFromFileMenu(page, 'Export SVG')
  expect(name).toBe('drawing.svg')
  expect(svg).toContain('viewBox="0 0 1600 1000" width="1600" height="1000"')
  expect(svg).toContain('<marker id="arrow-end-1"')
  expect(svg).toContain('>Hello SVG</tspan></text>')

  // Drawn by Chrome's SVG renderer, the export looks like the canvas.
  const { png } = await exportPixels(page, [])
  const { some, far } = await svgAgainstPng(page, svg, png)
  expect(far).toBeLessThan(200)
  expect(some).toBeLessThan(3200 * 2000 * 0.002)

  // Imported, it lands as one group on top, selected, named after the file. The text and the
  // arrowhead's marker are skipped, and a toast says so.
  await chooseFromFileMenu(page, 'Import SVG', 'drawing.svg', svg)
  await expect(page.getByRole('status')).toContainText(
    'Imported drawing. Skipped 2 unsupported elements',
  )
  expect(await shownShapes(page)).toEqual([
    'Path',
    'Rect',
    'Ellipse',
    'Arrow',
    'Path',
    'Text',
    'Group',
  ])
  expect((await groupChildren(page, 6)).map((child) => child.type)).toEqual(Array(5).fill('Path'))
  await expect(page.getByRole('button', { name: 'Select', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  expect(await selectedCount(page)).toBe(1)
  await page.getByRole('button', { name: 'Dismiss' }).click()
  await expect(page.getByRole('status')).toHaveText('')

  // The import lies exactly over the drawing, and went in as one step.
  const again = await exportPixels(page, [])
  expect((await svgAgainstPng(page, svg, again.png)).far).toBeLessThan(200)
  await undo.click()
  expect(await shownShapes(page)).toHaveLength(6)
})

test('save and open a .painter drawing, or a .painter.json one; Open is one undo step and refuses unknown versions', async ({
  page,
}) => {
  const undo = page.getByRole('button', { name: 'Undo' })
  const redo = page.getByRole('button', { name: 'Redo' })
  await drawLine(page, [0.1, 0.6], [0.4, 0.9])
  await page.getByRole('button', { name: 'Rectangle' }).click()
  await drawLine(page, [0.1, 0.1], [0.3, 0.3])
  const drawn = await shownAttr(page, 'x')

  // A .painter file is a zip of doc.json, and of the images, which this drawing has none of.
  const saved = await downloadBytesFromFileMenu(page, 'Save')
  expect(saved.name).toBe('drawing.painter')
  const { doc, others } = readPainter(saved.bytes)
  expect(others).toEqual([])
  expect(doc).toMatchObject({
    version: 3,
    pages: [{ width: 1600, height: 1000, background: { kind: 'solid', color: '#ffffff' } }],
    assets: {},
  })
  expect(doc.pages[0].rootIds).toHaveLength(2)

  // Ctrl+S saves too, instead of the browser saving the page.
  const viaKeys = page.waitForEvent('download')
  await page.keyboard.press('Control+s')
  expect((await viaKeys).suggestedFilename()).toBe('drawing.painter')

  await page.getByRole('button', { name: 'Clear' }).click()
  expect(await shownShapes(page)).toEqual([])
  // Saved empty first, so the check at the end can't pass on the drawing saved before Clear.
  await expect.poll(() => savedNodeCount(page)).toBe(0)

  // Ctrl+O opens the file picker, as File → Open does.
  const chooser = page.waitForEvent('filechooser')
  await page.keyboard.press('Control+o')
  await (
    await chooser
  ).setFiles({
    name: 'drawing.painter',
    mimeType: 'application/octet-stream',
    buffer: saved.bytes,
  })
  await expect.poll(() => shownShapes(page)).toEqual(['Path', 'Rect'])
  expect(await shownAttr(page, 'x')).toEqual(drawn)

  // Opening replaced the drawing in one step: undo brings back the cleared canvas.
  await undo.click()
  expect(await shownShapes(page)).toEqual([])
  await redo.click()
  expect(await shownShapes(page)).toEqual(['Path', 'Rect'])

  // A .painter.json file, as Save wrote before images, opens too.
  await page.getByRole('button', { name: 'Clear' }).click()
  await chooseFromFileMenu(page, 'Open', 'drawing.painter.json', JSON.stringify(doc))
  await expect.poll(() => shownShapes(page)).toEqual(['Path', 'Rect'])
  expect(await shownAttr(page, 'x')).toEqual(drawn)

  // A file from a newer version, or not a drawing at all, changes nothing.
  const future = JSON.stringify({ ...doc, version: 4 })
  await chooseFromFileMenu(page, 'Open', 'future.painter.json', future)
  await expect(page.getByRole('status')).toHaveText('This drawing is from an unknown version (4).')
  await chooseFromFileMenu(page, 'Open', 'notes.json', '{"hello": "world"}')
  await expect(page.getByRole('status')).toHaveText("This file isn't a Simple Painter drawing.")
  expect(await shownShapes(page)).toEqual(['Path', 'Rect'])

  // The opened drawing is autosaved like any other.
  await expect.poll(() => savedNodeCount(page)).toBe(2)
})

test.describe('files on a 375 px phone', () => {
  test.use({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true })

  test('the file menu exports and imports by touch', async ({ page }) => {
    const finger = await fingerOn(page)
    const undo = page.getByRole('button', { name: 'Undo' })
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(375)

    await page.getByRole('button', { name: 'Ellipse' }).tap()
    const box = await artboardBox(page)
    await finger.drag(onArtboard(box, [0.2, 0.2]), onArtboard(box, [0.5, 0.6]))
    expect(await shownShapes(page)).toEqual(['Ellipse'])

    // The menu drops down inside the screen, with items big enough for a finger.
    await page.getByRole('button', { name: 'File', exact: true }).tap()
    const menu = (await page.getByRole('menu', { name: 'File' }).boundingBox())!
    expect(menu.x).toBeGreaterThanOrEqual(0)
    expect(menu.x + menu.width).toBeLessThanOrEqual(375)
    const item = (await page.getByRole('menuitem', { name: 'Export SVG' }).boundingBox())!
    expect(item.height).toBeGreaterThanOrEqual(40)
    const downloadPromise = page.waitForEvent('download')
    await page.getByRole('menuitem', { name: 'Export SVG' }).tap()
    expect((await downloadPromise).suggestedFilename()).toBe('drawing.svg')
    await expect(page.getByRole('menu')).toHaveCount(0)

    // A circle, a line and a text: two paths in a group, and the text skipped.
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
      <circle cx="50" cy="50" r="40" fill="#22c55e"/>
      <line x1="10" y1="90" x2="90" y2="90" stroke="#000" stroke-width="4"/>
      <text x="10" y="20">Hi</text>
    </svg>`
    const chooser = page.waitForEvent('filechooser')
    await page.getByRole('button', { name: 'File', exact: true }).tap()
    await page.getByRole('menuitem', { name: 'Import SVG' }).tap()
    await (
      await chooser
    ).setFiles({
      name: 'badge.svg',
      mimeType: 'image/svg+xml',
      buffer: Buffer.from(svg),
    })
    await expect(page.getByRole('status')).toContainText('Skipped 1 unsupported element ')
    expect(await shownShapes(page)).toEqual(['Ellipse', 'Group'])
    expect((await exportPixels(page, [[100, 100]])).values).toEqual([GREEN])

    await undo.tap()
    expect(await shownShapes(page)).toEqual(['Ellipse'])
  })
})

test('the split eraser cuts strokes apart and leaves shapes alone, as one undo step', async ({
  page,
}) => {
  const undo = page.getByRole('button', { name: 'Undo' })
  const redo = page.getByRole('button', { name: 'Redo' })
  const split = page.getByRole('button', { name: 'Split', exact: true })
  // Canvas (800, 500), where the eraser crosses the stroke; (600, 500) and (1000, 500) beside it;
  // (800, 300) on the rectangle's top side, which the eraser crosses too.
  const cut = exportPixel([0.5, 0.5])
  const sides = [exportPixel([0.375, 0.5]), exportPixel([0.625, 0.5])]
  const rectTop = exportPixel([0.5, 0.3])

  await drawLine(page, [0.2, 0.5], [0.8, 0.5])
  await page.keyboard.press('r')
  await drawLine(page, [0.4, 0.3], [0.6, 0.7])
  await page.keyboard.press('e')
  await expect(page.getByRole('button', { name: 'Object', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await split.click()
  await expect(split).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByText('Erases parts of freehand strokes.')).toBeVisible()
  await drawLine(page, [0.5, 0.2], [0.5, 0.8])

  // The stroke is two now, the piece on the right just above the one on the left.
  expect(await shownShapes(page)).toEqual(['Path', 'Path', 'Rect'])
  expect((await exportPixels(page, [cut, ...sides, rectTop])).values).toEqual([
    WHITE,
    BLACK,
    BLACK,
    BLACK,
  ])

  // One undo step brings the whole stroke back, and redo cuts it again.
  await page.keyboard.press('Control+z')
  expect(await shownShapes(page)).toEqual(['Path', 'Rect'])
  expect((await exportPixels(page, [cut])).values).toEqual([BLACK])
  await redo.click()
  expect(await shownShapes(page)).toEqual(['Path', 'Path', 'Rect'])
  for (let i = 0; i < 3; i++) await undo.click()
  await expect(undo).toBeDisabled()

  // The mode stays as it was through tool switches.
  await page.keyboard.press('b')
  await page.keyboard.press('e')
  await expect(split).toHaveAttribute('aria-pressed', 'true')
})

test.describe('the split eraser on a 375 px phone', () => {
  test.use({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true })

  test('cuts by touch, and a pinch puts back what its first finger cut', async ({ page }) => {
    const finger = await fingerOn(page)
    const undo = page.getByRole('button', { name: 'Undo' })
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(375)

    // A stroke drawn by finger with the brush, then cut by finger in the middle.
    const box = await artboardBox(page)
    await finger.drag(onArtboard(box, [0.1, 0.5]), onArtboard(box, [0.9, 0.5]))
    await page.getByRole('button', { name: 'Eraser' }).tap()
    await page.getByRole('button', { name: 'Split', exact: true }).tap()
    await finger.drag(onArtboard(box, [0.5, 0.3]), onArtboard(box, [0.5, 0.7]))
    expect(await shownShapes(page)).toEqual(['Path', 'Path'])
    const pixels = [exportPixel([0.5, 0.5]), exportPixel([0.3, 0.5]), exportPixel([0.7, 0.5])]
    expect((await exportPixels(page, pixels)).values).toEqual([WHITE, BLACK, BLACK])

    // A first finger cuts the piece on the right; a second one before it moves 8 px is a pinch,
    // which puts the piece back and records nothing.
    const [x, y] = onArtboard(box, [0.7, 0.5])
    await touch(page, 'pointerdown', 1, [x, y])
    await touch(page, 'pointermove', 1, [x, y + 3])
    expect(await shownShapes(page)).toEqual(['Path', 'Path', 'Path'])
    await touch(page, 'pointerdown', 2, [x + 80, y])
    expect(await shownShapes(page)).toEqual(['Path', 'Path'])
    await touch(page, 'pointerup', 1, [x, y + 3])
    await touch(page, 'pointerup', 2, [x + 80, y])

    // The cut and the stroke: a step each.
    await undo.tap()
    expect(await shownShapes(page)).toEqual(['Path'])
    await undo.tap()
    await expect(undo).toBeDisabled()
    expect(await shownShapes(page)).toEqual([])
  })
})

/** The page point at the middle of the shape at `index` on the content layer. */
function shapeCenterOf(page: Page, index: number): Promise<Xy> {
  return page.evaluate((index) => {
    const stage = (window as unknown as { Konva: typeof Konva }).Konva.stages[0]
    const rect = stage.getLayers()[1].getChildren()[index].getClientRect()
    const origin = stage.container().getBoundingClientRect()
    return [origin.x + rect.x + rect.width / 2, origin.y + rect.y + rect.height / 2] as Xy
  }, index)
}

test('release: draw a shape, transform it, draw a pen path, undo and download the SVG', async ({
  page,
}) => {
  const undo = page.getByRole('button', { name: 'Undo' })
  const box = await artboardBox(page)

  // A red rectangle, selected with the select tool once drawn.
  await page.keyboard.press('r')
  await drawLine(page, [0.2, 0.2], [0.4, 0.5])
  await page.getByRole('button', { name: 'Fill #ef4444' }).click()
  expect(await shownShapes(page)).toEqual(['Rect'])
  const [drawnWidth] = (await shownAttr(page, 'width')) as number[]

  // Stretched by its middle-right handle: the stretch goes into its width, not its scale.
  const grip = await handleAt(page, 'middle-right')
  await drag(page, grip, [grip[0] + 100, grip[1]])
  const [stretchedWidth] = (await shownAttr(page, 'width')) as number[]
  expect(stretchedWidth).toBeGreaterThan(drawnWidth + 50)
  expect(await shownTransforms(page)).toEqual([expect.objectContaining({ scaleX: 1, scaleY: 1 })])

  // A quarter turn, snapped by Shift.
  const middle = await shapeCenterOf(page, 0)
  await page.keyboard.down('Shift')
  await drag(page, await handleAt(page, 'rotater'), [middle[0] + 150, middle[1]])
  await page.keyboard.up('Shift')
  const [turned] = await shownTransforms(page)
  expect(turned.rotation).toBe(90)

  // A pen path, ended with Enter, then taken back with one undo.
  await page.keyboard.press('p')
  await page.mouse.click(...onArtboard(box, [0.6, 0.2]))
  await drag(page, onArtboard(box, [0.75, 0.6]), onArtboard(box, [0.85, 0.6]))
  await page.mouse.click(...onArtboard(box, [0.9, 0.2]))
  await page.keyboard.press('Enter')
  expect(await shownShapes(page)).toEqual(['Rect', 'Path'])
  await page.keyboard.press('Control+z')
  expect(await shownShapes(page)).toEqual(['Rect'])
  expect(await shownTransforms(page)).toEqual([turned])

  // The SVG holds the turned rectangle and not the path, and looks like the PNG.
  const { name, text: svg } = await downloadFromFileMenu(page, 'Export SVG')
  expect(name).toBe('drawing.svg')
  expect(svg).toMatch(/<rect transform="translate\([\d. ]+\) rotate\(90\)" width="[\d.]+"/)
  expect(svg).toContain('fill="#ef4444"')
  expect(svg).not.toContain('<path')
  const { png } = await exportPixels(page, [])
  expect((await svgAgainstPng(page, svg, png)).far).toBeLessThan(200)

  // Draw, fill, stretch and turn: a step each.
  for (let i = 0; i < 4; i++) await undo.click()
  await expect(undo).toBeDisabled()
  expect(await shownShapes(page)).toEqual([])
})

test('release: every object type turns, restyles, reorders and deletes, one undo step each', async ({
  page,
}) => {
  const undo = page.getByRole('button', { name: 'Undo' })
  const box = await artboardBox(page)
  const select = async () => {
    await page.keyboard.press('v')
    await nextFrame(page)
  }
  // A stroke along the bottom, for each object to go behind.
  await drawLine(page, [0.05, 0.95], [0.95, 0.95])

  const kinds: { name: string; shape: string; steps: number; draw(): Promise<void> }[] = [
    {
      name: 'Stroke',
      shape: 'Path',
      steps: 1,
      async draw() {
        await page.keyboard.press('b')
        await drawLine(page, [0.3, 0.3], [0.6, 0.6])
        await select()
        await page.mouse.click(...onArtboard(box, [0.45, 0.45]))
      },
    },
    {
      name: 'Rectangle',
      shape: 'Rect',
      steps: 1,
      async draw() {
        await page.keyboard.press('r')
        await drawLine(page, [0.3, 0.3], [0.6, 0.6])
      },
    },
    {
      name: 'Ellipse',
      shape: 'Ellipse',
      steps: 1,
      async draw() {
        await page.keyboard.press('o')
        await drawLine(page, [0.3, 0.3], [0.6, 0.6])
      },
    },
    {
      name: 'Line',
      shape: 'Arrow',
      steps: 1,
      async draw() {
        await page.keyboard.press('l')
        await drawLine(page, [0.3, 0.45], [0.6, 0.45])
      },
    },
    {
      name: 'Path',
      shape: 'Path',
      steps: 1,
      async draw() {
        await page.keyboard.press('p')
        await page.mouse.click(...onArtboard(box, [0.3, 0.3]))
        await page.mouse.click(...onArtboard(box, [0.6, 0.3]))
        await page.mouse.click(...onArtboard(box, [0.45, 0.6]))
        await page.keyboard.press('Enter')
      },
    },
    {
      name: 'Text',
      shape: 'Text',
      steps: 1,
      async draw() {
        await page.keyboard.press('t')
        await page.mouse.click(...onArtboard(box, [0.3, 0.4]))
        await page.keyboard.type('Release')
        await page.keyboard.press('Control+Enter')
      },
    },
    {
      name: 'Group',
      shape: 'Group',
      steps: 3,
      async draw() {
        await page.keyboard.press('r')
        await drawLine(page, [0.3, 0.3], [0.4, 0.4])
        await page.keyboard.press('o')
        await drawLine(page, [0.5, 0.5], [0.6, 0.6])
        await select()
        await drag(page, onArtboard(box, [0.25, 0.25]), onArtboard(box, [0.65, 0.65]))
        await page.keyboard.press('Control+g')
      },
    },
  ]

  for (const kind of kinds) {
    await kind.draw()
    await expect(page.getByRole('heading', { name: kind.name, exact: true })).toBeVisible()
    expect(await shownShapes(page)).toEqual(['Path', kind.shape])
    const [, drawn] = await shownTransforms(page)
    const [, drawnData] = await shownAttr(page, 'points')

    // A line turns by its end handle, everything else a quarter turn by the Transformer.
    if (kind.name === 'Line') {
      const end = await overlayPointOf(page, 'line-end')
      await drag(page, end, [end[0], end[1] + 100])
      expect((await shownAttr(page, 'points'))[1]).not.toEqual(drawnData)
    } else {
      const middle = await shapeCenterOf(page, 1)
      await page.keyboard.down('Shift')
      await drag(page, await handleAt(page, 'rotater'), [middle[0] + 150, middle[1]])
      await page.keyboard.up('Shift')
      expect((await shownTransforms(page))[1].rotation).toBe(90)
    }

    // Restyled, sent to the back and deleted. One key press on the slider is one edit, whatever
    // the time between presses.
    const opacity = page.getByRole('slider', { name: 'Opacity' })
    await opacity.focus()
    await page.keyboard.press('PageDown')
    await opacity.blur()
    expect((await shownAttr(page, 'opacity'))[1]).toBeLessThan(1)
    await page.keyboard.press('Control+Shift+BracketLeft')
    expect(await shownShapes(page)).toEqual([kind.shape, 'Path'])
    await page.keyboard.press('Delete')
    expect(await shownShapes(page)).toEqual(['Path'])

    // Delete, reorder, restyle and turn undo a step each, then the object itself goes.
    await undo.click()
    expect(await shownShapes(page)).toEqual([kind.shape, 'Path'])
    await undo.click()
    expect(await shownShapes(page)).toEqual(['Path', kind.shape])
    await undo.click()
    expect((await shownAttr(page, 'opacity'))[1]).toBe(1)
    await undo.click()
    expect((await shownTransforms(page))[1]).toEqual(drawn)
    expect((await shownAttr(page, 'points'))[1]).toEqual(drawnData)
    for (let i = 0; i < kind.steps; i++) await undo.click()
    expect(await shownShapes(page)).toEqual(['Path'])
  }
  await undo.click()
  await expect(undo).toBeDisabled()
})

/** Writes a value into the app's IndexedDB store, as an older version would have saved it. */
function putSaved(page: Page, key: string, value: unknown) {
  return page.evaluate(
    ({ key, value }) =>
      new Promise<void>((resolve, reject) => {
        const open = indexedDB.open('painter')
        open.onerror = () => reject(open.error)
        open.onsuccess = () => {
          const db = open.result
          const tx = db.transaction('kv', 'readwrite')
          tx.objectStore('kv').put(value, key)
          tx.oncomplete = () => {
            db.close()
            resolve()
          }
          tx.onerror = () => {
            db.close()
            reject(tx.error)
          }
        }
      }),
    { key, value },
  )
}

/** The pages panel's page names, in order, and the current one. */
async function pageNames(page: Page) {
  const buttons = page.getByRole('list', { name: 'Page list' }).getByRole('button')
  const names = await buttons.evaluateAll((all) =>
    all.map((b) => `${b.getAttribute('aria-label')}${b.getAttribute('aria-current') ? '*' : ''}`),
  )
  return names
}

/** The artboard's width over its height, as the canvas shows the current page. */
async function pageRatio(page: Page) {
  const box = await artboardBox(page)
  return Math.round((box.width / box.height) * 100) / 100
}

test('a v2 drawing opens as one 1600 × 1000 page that looks the same', async ({ page }) => {
  const corner = (x: number, y: number) => ({
    x,
    y,
    inX: 0,
    inY: 0,
    outX: 0,
    outY: 0,
    kind: 'corner',
  })
  const base = {
    parentId: null,
    hidden: false,
    locked: false,
    transform: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 },
  }
  const v2 = {
    version: 2,
    width: 1600,
    height: 1000,
    background: '#ffffff',
    rootIds: ['r', 'p'],
    nodes: {
      r: {
        ...base,
        id: 'r',
        type: 'rect',
        name: 'Rectangle',
        transform: { ...base.transform, x: 200, y: 200 },
        style: { fill: '#ef4444', stroke: '#000000', strokeWidth: 8, opacity: 1 },
        width: 400,
        height: 300,
        cornerRadius: 0,
      },
      p: {
        ...base,
        id: 'p',
        type: 'path',
        name: 'Path',
        transform: { ...base.transform, x: 800, y: 500 },
        style: { fill: '#3b82f6', stroke: null, strokeWidth: 4, opacity: 1 },
        anchors: [corner(0, 0), corner(300, 0), corner(300, 300)],
        closed: true,
      },
    },
  }
  await putSaved(page, 'painter:v2', v2)
  await page.reload()
  await waitForCanvas(page)

  // Migration is not an undo step, and the drawing shows on one page of the same size.
  await expect(page.getByRole('button', { name: 'Undo' })).toBeDisabled()
  expect(await shownShapes(page)).toEqual(['Rect', 'Path'])
  expect(await pageNames(page)).toEqual(['Page 1*'])
  const { png, values } = await exportPixels(page, [
    [800, 700],
    [2100, 1100],
    [2600, 1800],
  ])
  expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([3200, 2000])
  expect(values).toEqual([RED, BLUE, WHITE])

  // Saved as v3 right away; the v2 drawing stays as a backup.
  await expect
    .poll(async () => ((await savedDoc(page)) as { version?: number } | null)?.version)
    .toBe(3)
  expect(await savedValue(page, 'painter:v2')).toEqual(v2)
})

test('pages add, show, resize, rename, reorder and delete, one undo step each', async ({
  page,
}) => {
  const undo = page.getByRole('button', { name: 'Undo' })
  const redo = page.getByRole('button', { name: 'Redo' })
  const pages = page.getByRole('complementary', { name: 'Pages' })

  await drawLine(page, [0.2, 0.5], [0.8, 0.5])
  await pages.getByRole('button', { name: 'Add page' }).click()
  expect(await pageNames(page)).toEqual(['Page 1', 'Page 2*'])
  expect(await shownShapes(page)).toEqual([])
  await drawLine(page, [0.2, 0.2], [0.4, 0.4])
  expect(await shownShapes(page)).toEqual(['Path'])

  // PageUp and PageDown go through the pages; each keeps what was drawn on it.
  await page.keyboard.press('PageUp')
  expect(await pageNames(page)).toEqual(['Page 1*', 'Page 2'])
  expect(await shownShapes(page)).toEqual(['Path'])
  await page.keyboard.press('PageDown')
  expect(await pageNames(page)).toEqual(['Page 1', 'Page 2*'])

  // Its thumbnail is drawn from the page.
  await expect(pages.getByRole('button', { name: 'Page 1' }).locator('img')).toHaveAttribute(
    'src',
    /^blob:/,
  )

  // A square page exports as a square PNG, twice its size.
  await page.getByRole('button', { name: 'Select', exact: true }).click()
  await page.getByRole('combobox', { name: 'Page size' }).selectOption('square')
  expect(await pageRatio(page)).toBe(1)
  const { png } = await exportPixels(page, [])
  expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([2160, 2160])

  // Undo takes back the resize, the stroke and the added page, one step each.
  await undo.click()
  expect(await pageRatio(page)).toBe(1.6)
  await undo.click()
  expect(await shownShapes(page)).toEqual([])
  await undo.click()
  expect(await pageNames(page)).toEqual(['Page 1*'])
  await redo.click()
  await redo.click()
  await redo.click()
  expect(await pageNames(page)).toEqual(['Page 1', 'Page 2*'])
  expect(await pageRatio(page)).toBe(1)

  // A double-click renames a page, as one step.
  await pages.getByRole('button', { name: 'Page 2' }).dblclick()
  await pages.getByRole('textbox', { name: 'Page name' }).fill('Cover')
  await page.keyboard.press('Enter')
  expect(await pageNames(page)).toEqual(['Page 1', 'Cover*'])

  // Dragging a page above another moves it there.
  const cover = (await pages.getByRole('button', { name: 'Cover' }).boundingBox())!
  const first = (await pages.getByRole('button', { name: 'Page 1' }).boundingBox())!
  await drag(
    page,
    [cover.x + cover.width / 2, cover.y + cover.height / 2],
    [first.x + first.width / 2, first.y + 4],
  )
  expect(await pageNames(page)).toEqual(['Cover*', 'Page 1'])
  await undo.click()
  expect(await pageNames(page)).toEqual(['Page 1', 'Cover*'])

  // Deleting the page shows its neighbour; undo brings it back and shows it.
  await pages.getByRole('button', { name: 'Delete page' }).click()
  expect(await pageNames(page)).toEqual(['Page 1*'])
  await expect(pages.getByRole('button', { name: 'Delete page' })).toBeDisabled()
  await undo.click()
  expect(await pageNames(page)).toEqual(['Page 1', 'Cover*'])
  expect(await shownShapes(page)).toEqual(['Path'])
})

test('a right-click moves the selection to another page, where it was on this one', async ({
  page,
}) => {
  const undo = page.getByRole('button', { name: 'Undo' })
  await page.getByRole('button', { name: 'Rectangle' }).click()
  await drawLine(page, [0.1, 0.1], [0.3, 0.3])
  const placed = await shownAttr(page, 'x')
  await page
    .getByRole('complementary', { name: 'Pages' })
    .getByRole('button', { name: 'Add page' })
    .click()
  await page.keyboard.press('PageUp')
  expect(await shownShapes(page)).toEqual(['Rect'])

  // On its outline: an unfilled rectangle is picked there only.
  const box = await artboardBox(page)
  await page.mouse.click(...onArtboard(box, [0.1, 0.2]), { button: 'right' })
  await page.getByRole('menuitem', { name: 'Move to Page 2' }).click()
  await expect(page.getByRole('status')).toHaveText('Moved 1 object to Page 2.')
  expect(await shownShapes(page)).toEqual([])
  await page.keyboard.press('PageDown')
  expect(await shownShapes(page)).toEqual(['Rect'])
  expect(await shownAttr(page, 'x')).toEqual(placed)

  // One undo step, shown where it happened.
  await undo.click()
  expect(await shownShapes(page)).toEqual([])
  await page.keyboard.press('PageUp')
  expect(await shownShapes(page)).toEqual(['Rect'])
})

test.describe('pages on a 375 px phone', () => {
  test.use({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true })

  test('the Pages tab adds and shows pages by touch, within the screen', async ({ page }) => {
    await page.getByRole('tab', { name: 'Pages' }).tap()
    const pages = page.getByRole('complementary', { name: 'Pages' })
    await pages.getByRole('button', { name: 'Add page' }).tap()
    await pages.getByRole('button', { name: 'Add page' }).tap()
    expect(await pageNames(page)).toEqual(['Page 1', 'Page 2', 'Page 3*'])
    await pages.getByRole('button', { name: 'Page 1' }).tap()
    expect(await pageNames(page)).toEqual(['Page 1*', 'Page 2', 'Page 3'])
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(375)
  })
})

/** The page point over a canvas point, at the current zoom and pan. */
function screenOf(page: Page, at: Xy): Promise<Xy> {
  return page.evaluate(([x, y]) => {
    const stage = (window as unknown as { Konva: typeof Konva }).Konva.stages[0]
    const origin = stage.container().getBoundingClientRect()
    return [origin.x + stage.x() + x * stage.scaleX(), origin.y + stage.y() + y * stage.scaleY()]
  }, at) as Promise<Xy>
}

/** Screen pixels per canvas unit. */
const zoomOf = (page: Page) =>
  page.evaluate(() => (window as unknown as { Konva: typeof Konva }).Konva.stages[0].scaleX())

/** The smart guides on the overlay, as their Konva points: [x1, y1, x2, y2] in canvas units. */
function shownGuides(page: Page): Promise<number[][]> {
  return page.evaluate(() =>
    (window as unknown as { Konva: typeof Konva }).Konva.stages[0]
      .find<Konva.Line>('.snap-guide')
      .map((line) => line.points()),
  )
}

/**
 * Drags the mouse from one canvas point by (dx, dy) screen pixels and returns the guides shown
 * just before the release. `mod` holds Ctrl for the whole drag.
 */
async function dragOnCanvas(page: Page, from: Xy, [dx, dy]: Xy, mod = false) {
  const start = await screenOf(page, from)
  await page.mouse.move(...start)
  if (mod) await page.keyboard.down('Control')
  await page.mouse.down()
  const steps = 10
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(start[0] + (dx * i) / steps, start[1] + (dy * i) / steps)
  }
  const guides = await shownGuides(page)
  await page.mouse.up()
  if (mod) await page.keyboard.up('Control')
  return guides
}

test('objects snap to the page edge and to each other within 6 screen px, with guides', async ({
  page,
}) => {
  const shown = async (index: number) => (await shownTransforms(page))[index]
  const view = page.getByRole('button', { name: 'View', exact: true })
  const toggle = async (name: string) => {
    await view.click()
    await page.getByRole('menuitemcheckbox', { name }).click()
  }

  // Two rectangles with the default 4-unit outline, so each one's ink reaches 2 past its box.
  const drawRect = async (from: Xy, to: Xy) => {
    await page.keyboard.press('r')
    await drag(page, await screenOf(page, from), await screenOf(page, to))
  }
  await drawRect([480, 300], [640, 400])
  await drawRect([960, 600], [1120, 700])
  expect(await shownShapes(page)).toEqual(['Rect', 'Rect'])
  const zoom = await zoomOf(page)

  // The second one, selected, dragged from its middle to 3 px right of the page's left edge:
  // its ink lands on the edge, under a guide as tall as the page.
  let guides = await dragOnCanvas(page, [1040, 650], [-958 * zoom + 3, 0])
  expect((await shown(1)).x).toBeCloseTo(2, 6)
  expect(guides).toEqual([[0, 0, 0, 1000]])
  await expect.poll(() => shownGuides(page)).toEqual([])

  // Then 4 px right of the first one's ink: its left meets that right edge, under a guide from
  // one to the other.
  guides = await dragOnCanvas(page, [82, 650], [642 * zoom + 4, 0])
  expect((await shown(1)).x).toBeCloseTo(644, 6)
  expect(guides).toHaveLength(1)
  expect(guides[0][0]).toBeCloseTo(642, 6)
  expect(guides[0][1]).toBeCloseTo(298, 6)
  expect(guides[0][3]).toBeCloseTo(702, 6)

  // Ctrl drags without snapping: 4 px left, it stays there.
  guides = await dragOnCanvas(page, [724, 650], [-4, 0], true)
  expect(guides).toEqual([])
  expect((await shown(1)).x).toBeLessThan(644 - 2 / zoom)

  // The View menu turns snapping off: dropped 3 px past that edge, it stays there too.
  await view.click()
  const snapping = page.getByRole('menuitemcheckbox', { name: 'Snapping' })
  await expect(snapping).toHaveAttribute('aria-checked', 'true')
  await snapping.click()
  guides = await dragOnCanvas(page, [722, 650], [7, 0])
  expect(guides).toEqual([])
  expect((await shown(1)).x).toBeGreaterThan(644 + 1 / zoom)
  await toggle('Snapping')

  // With the grid on, it shows, and the top or bottom of a box dragged clear of other objects
  // lands on one of its 8-unit lines.
  await toggle('Grid')
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { Konva: typeof Konva }).Konva.stages[0].find('.snap-grid').length,
      ),
    )
    .toBe(1)
  await dragOnCanvas(page, [730, 650], [0, 37])
  const { y } = await shown(1)
  const onGrid = (v: number) => Math.abs(v / 8 - Math.round(v / 8)) < 1e-6
  expect(onGrid(y - 2) || onGrid(y + 102)).toBe(true)
  await toggle('Grid')

  // A resize snaps too: the right handle let go 3 px short of the page's right edge takes the
  // ink there; the outline stays 2 units past the box.
  const { x } = await shown(1)
  const width = (await shownAttr(page, 'width'))[1] as number
  const handle = await handleAt(page, 'middle-right')
  await drag(page, handle, [handle[0] + (1598 - x - width) * zoom - 3, handle[1]])
  expect((await shown(1)).x).toBeCloseTo(x, 6)
  expect(((await shownAttr(page, 'width'))[1] as number) + x).toBeCloseTo(1598, 4)

  // Each of the five moves and the resize was one undo step.
  const undo = page.getByRole('button', { name: 'Undo' })
  for (let i = 0; i < 6; i++) await undo.click()
  expect((await shown(1)).x).toBeCloseTo(960, 6)
  expect((await shownAttr(page, 'width'))[1]).toBe(160)
})

type ShownRect = { x: number; y: number; width: number; height: number; rotation: number }

/** Each shape on the content layer, bottom to top, by its Konva position, size and rotation. */
function shownRects(page: Page): Promise<ShownRect[]> {
  return page.evaluate(() =>
    (window as unknown as { Konva: typeof Konva }).Konva.stages[0]
      .getLayers()[1]
      .getChildren()
      .map((n) => ({
        x: n.x(),
        y: n.y(),
        width: n.width() * n.scaleX(),
        height: n.height() * n.scaleY(),
        rotation: n.rotation(),
      })),
  )
}

/** Draws a rectangle with the rectangle tool between two canvas points. */
async function drawRectOnCanvas(page: Page, from: Xy, to: Xy) {
  await page.keyboard.press('r')
  await drag(page, await screenOf(page, from), await screenOf(page, to))
}

test('objects align and distribute from the keyboard and the toolbar, one undo step each', async ({
  page,
}) => {
  // Three rectangles with the same 4-unit outline, so their boxes line up as their inks do.
  await drawRectOnCanvas(page, [100, 100], [300, 200])
  await drawRectOnCanvas(page, [500, 300], [600, 400])
  await drawRectOnCanvas(page, [1200, 700], [1300, 900])
  await page.keyboard.press('Control+a')
  await expect.poll(() => selectedCount(page)).toBe(3)

  const steps = [await shownRects(page)]
  // Waits for the command to show, checks it and keeps the result.
  const step = async (check: (rects: ShownRect[]) => void) => {
    await expect.poll(() => shownRects(page)).not.toEqual(steps.at(-1))
    const rects = await shownRects(page)
    check(rects)
    steps.push(rects)
  }
  const same = (values: number[]) => {
    for (const v of values) expect(v).toBeCloseTo(values[0], 6)
  }

  // Alt + Shift + V spaces them evenly down the page; the toolbar does it across.
  await page.keyboard.press('Alt+Shift+V')
  await step(([a, b, c]) => {
    expect(b.y - (a.y + a.height)).toBeCloseTo(c.y - (b.y + b.height), 6)
    expect([a.y, c.y]).toEqual([steps[0][0].y, steps[0][2].y])
  })
  await page.getByRole('button', { name: 'Distribute horizontally' }).click()
  await step(([a, b, c]) => {
    expect(b.x - (a.x + a.width)).toBeCloseTo(c.x - (b.x + b.width), 6)
  })

  // Alt + A lines the left edges up on the leftmost; the toolbar lines the bottoms up on the
  // lowest.
  await page.keyboard.press('Alt+A')
  await step((rects) => {
    same(rects.map((r) => r.x))
    expect(rects[0].x).toBe(steps[0][0].x)
  })
  await page.getByRole('button', { name: 'Align bottom edges' }).click()
  await step((rects) => {
    same(rects.map((r) => r.y + r.height))
    expect(rects[2].y).toBe(steps[0][2].y)
  })

  // One object aligns to the page: the tallest, picked by its top edge, goes to the page's
  // horizontal center with Alt + H.
  const tall = steps.at(-1)![2]
  await page.mouse.click(...(await screenOf(page, [tall.x + tall.width / 2, tall.y])))
  await expect.poll(() => selectedCount(page)).toBe(1)
  await page.keyboard.press('Alt+H')
  await step(([a, b, c]) => {
    expect(c.x + c.width / 2).toBeCloseTo(800, 6)
    expect([a, b]).toEqual(steps.at(-1)!.slice(0, 2))
  })

  // Each command was one undo step.
  const undo = page.getByRole('button', { name: 'Undo' })
  for (let i = steps.length - 2; i >= 0; i--) {
    await undo.click()
    await expect.poll(() => shownRects(page)).toEqual(steps[i])
  }
})

test('the X, Y, W, H and rotation fields follow drags live and apply typed math, one step each', async ({
  page,
}) => {
  await drawRectOnCanvas(page, [400, 300], [600, 400])
  const field = (name: string) => page.getByRole('textbox', { name, exact: true })
  const valueOf = async (name: string) => Number(await field(name).inputValue())
  const shown = async () => (await shownRects(page))[0]
  // The fields go by the ink: the 4-unit outline reaches 2 past the rectangle.
  const start = await shown()
  await expect.poll(() => valueOf('X')).toBeCloseTo(start.x - 2, 1)
  expect(await valueOf('Width')).toBeCloseTo(start.width + 4, 1)
  expect(await valueOf('Height')).toBeCloseTo(start.height + 4, 1)
  await expect(field('Rotation')).toHaveValue('0')

  // A move shows in X while the drag goes on, Ctrl keeping snapping out of it.
  const zoom = await zoomOf(page)
  const edge = await screenOf(page, [start.x, start.y + start.height / 2])
  await page.mouse.move(...edge)
  await page.keyboard.down('Control')
  await page.mouse.down()
  for (let i = 1; i <= 5; i++) await page.mouse.move(edge[0] + 8 * i, edge[1])
  const moving = await shown()
  expect(moving.x).toBeCloseTo(start.x + 40 / zoom, 1)
  await expect.poll(() => valueOf('X')).toBeCloseTo(moving.x - 2, 1)
  await page.mouse.up()
  await page.keyboard.up('Control')

  // So does a resize by the Transformer's handle, though Konva holds it until the release.
  const handle = await handleAt(page, 'middle-right')
  await page.mouse.move(...handle)
  await page.keyboard.down('Control')
  await page.mouse.down()
  for (let i = 1; i <= 5; i++) await page.mouse.move(handle[0] + 10 * i, handle[1])
  const stretching = await shown()
  expect(stretching.width).toBeGreaterThan(start.width + 40 / zoom)
  await expect.poll(() => valueOf('Width')).toBeCloseTo(stretching.width + 4, 1)
  await page.mouse.up()
  await page.keyboard.up('Control')
  // Baking rounds the scale to millionths.
  await expect.poll(async () => (await shown()).width).toBeCloseTo(stretching.width, 2)
  const resized = await shown()

  // Typed values apply on Enter, worked out when they are sums; Esc puts the field back.
  await field('X').fill('200/2')
  await field('X').press('Enter')
  await expect(field('X')).toHaveValue('100')
  expect((await shown()).x).toBeCloseTo(102, 6)
  await field('Width').fill('999')
  await field('Width').press('Escape')
  expect(await valueOf('Width')).toBeCloseTo(resized.width + 4, 1)
  await field('Width').fill('300')
  await field('Width').press('Enter')
  await expect(field('Width')).toHaveValue('300')
  // The outline keeps its width, so the rectangle takes the rest.
  expect((await shown()).width).toBeCloseTo(296, 6)
  expect((await shown()).x).toBeCloseTo(102, 6)

  // With the ratio kept, a new height scales the width too.
  const before = await shown()
  await page.getByRole('button', { name: 'Keep ratio' }).click()
  await field('Height').fill('(50 + 4) * 2')
  await field('Height').press('Enter')
  await expect(field('Height')).toHaveValue('108')
  const kept = await shown()
  expect(kept.height).toBeCloseTo(104, 6)
  expect(kept.width).toBeCloseTo((before.width * 104) / before.height, 6)

  // Rotation turns it about its middle; its box is then the turned rectangle's.
  await field('Rotation').fill('90')
  await field('Rotation').press('Enter')
  await expect.poll(async () => (await shown()).rotation).toBe(90)
  await expect.poll(() => valueOf('Width')).toBeCloseTo(kept.height + 4, 1)
  expect(await valueOf('Height')).toBeCloseTo(kept.width + 4, 1)

  // Each typed change was one undo step, as were the move and the resize.
  const undo = page.getByRole('button', { name: 'Undo' })
  await undo.click()
  await expect.poll(shown).toEqual(kept)
  await undo.click()
  await expect.poll(shown).toEqual(before)
  for (let i = 0; i < 2; i++) await undo.click()
  await expect.poll(shown).toEqual(resized)
  for (let i = 0; i < 2; i++) await undo.click()
  await expect.poll(shown).toEqual(start)
})

type ShownFill = {
  priority: string
  color?: string
  start?: Xy
  end?: Xy
  center?: Xy
  radius?: number
  stops?: (string | number)[]
}

/** How Konva fills a shape on the content layer: its color, or its gradient in local pixels. */
function shownFill(page: Page, index = 0): Promise<ShownFill> {
  return page.evaluate((index) => {
    const shape = (window as unknown as { Konva: typeof Konva }).Konva.stages[0]
      .getLayers()[1]
      .getChildren()[index] as Konva.Shape
    const xy = ({ x, y }: { x: number; y: number }): Xy => [x, y]
    const priority = shape.fillPriority()
    if (priority === 'linear-gradient') {
      return {
        priority,
        start: xy(shape.fillLinearGradientStartPoint()),
        end: xy(shape.fillLinearGradientEndPoint()),
        stops: shape.fillLinearGradientColorStops(),
      }
    }
    if (priority === 'radial-gradient') {
      return {
        priority,
        center: xy(shape.fillRadialGradientEndPoint()),
        radius: shape.fillRadialGradientEndRadius(),
        stops: shape.fillRadialGradientColorStops(),
      }
    }
    return { priority, color: String(shape.fill()) }
  }, index)
}

/** Drags the mouse between two page points in small steps; Shift is held when asked. */
async function dragWith(page: Page, from: Xy, to: Xy, shift = false) {
  if (shift) await page.keyboard.down('Shift')
  await drag(page, from, to, 10)
  if (shift) await page.keyboard.up('Shift')
}

test('a gradient set from the panel drags by its handles and stops, one undo step each', async ({
  page,
}) => {
  await drawRectOnCanvas(page, [200, 200], [600, 400])
  const [rect] = await shownRects(page)
  const { width: w, height: h } = rect
  const fillType = page.getByRole('group', { name: 'Fill type' })
  const steps: ShownFill[] = [await shownFill(page)]
  const step = async (check: (fill: ShownFill) => void) => {
    await expect.poll(() => shownFill(page)).not.toEqual(steps.at(-1))
    const fill = await shownFill(page)
    check(fill)
    steps.push(fill)
  }

  // Linear, from the outline's black to white, left to right across the middle.
  await fillType.getByRole('button', { name: 'Linear', exact: true }).click()
  await expect(fillType.getByRole('button', { name: 'Linear', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await step((fill) => {
    expect(fill).toMatchObject({ priority: 'linear-gradient', stops: [0, '#000000', 1, '#ffffff'] })
    expect(fill.start![0]).toBeCloseTo(0, 6)
    expect(fill.start![1]).toBeCloseTo(h / 2, 6)
    expect(fill.end![0]).toBeCloseTo(w, 6)
  })

  // The end handle drags to the bottom-right corner.
  await dragWith(
    page,
    await overlayPointOf(page, 'gradient-end'),
    await screenOf(page, [rect.x + w, rect.y + h]),
  )
  // The mouse moves in whole screen pixels.
  const zoom = await zoomOf(page)
  await step((fill) => {
    expect(Math.abs(fill.end![0] - w)).toBeLessThan(1 / zoom)
    expect(Math.abs(fill.end![1] - h)).toBeLessThan(1 / zoom)
  })

  // With Shift, the start turns about the end in 45° steps: nearly level snaps level.
  await dragWith(
    page,
    await overlayPointOf(page, 'gradient-start'),
    await screenOf(page, [rect.x + w * 0.25, rect.y + h * 0.95]),
    true,
  )
  await step((fill) => {
    expect(fill.start![1]).toBeCloseTo(fill.end![1], 6)
    expect(fill.start![0]).toBeLessThan(w / 2)
  })

  // A click on the stop bar adds a stop there in the color the gradient has; it takes a swatch.
  await page.getByTitle('Click to add a stop').click()
  await expect(page.getByRole('slider', { name: 'Stop 3' })).toHaveAttribute('aria-valuenow', '50')
  await step((fill) => expect(fill.stops).toEqual([0, '#000000', 0.5, '#808080', 1, '#ffffff']))
  await page.getByRole('button', { name: 'Stop #22c55e' }).click()
  await step((fill) => expect(fill.stops).toEqual([0, '#000000', 0.5, '#22c55e', 1, '#ffffff']))

  // Dragging its marker moves it along the gradient, as one step.
  const marker = page.getByRole('slider', { name: 'Stop 3' })
  const box = (await marker.boundingBox())!
  const markerAt: Xy = [box.x + box.width / 2, box.y + box.height / 2]
  await dragWith(page, markerAt, [markerAt[0] - 40, markerAt[1]])
  await step((fill) => {
    expect(fill.stops![2]).toBeLessThan(0.5)
    expect(fill.stops![3]).toBe('#22c55e')
  })

  // Radial, from the middle to half the longer side; its radius handle drags outward.
  await fillType.getByRole('button', { name: 'Radial', exact: true }).click()
  await step((fill) => {
    expect(fill.priority).toBe('radial-gradient')
    expect(fill.center![0]).toBeCloseTo(w / 2, 6)
    expect(fill.radius).toBeCloseTo(Math.max(w, h) / 2, 6)
  })
  const radiusAt = await overlayPointOf(page, 'gradient-radius')
  await dragWith(page, radiusAt, [radiusAt[0] + 60, radiusAt[1]])
  await step((fill) => {
    expect(Math.abs(fill.radius! - (Math.max(w, h) / 2 + 60 / zoom))).toBeLessThan(1 / zoom)
  })

  // Saved with the drawing, in box units.
  await expect
    .poll(async () => (await savedNodes(page))[0] as unknown)
    .toMatchObject({ style: { fill: { kind: 'radial', center: [0.5, 0.5] } } })

  // Each was one undo step.
  const undo = page.getByRole('button', { name: 'Undo' })
  for (let i = steps.length - 2; i >= 0; i--) {
    await undo.click()
    await expect.poll(() => shownFill(page)).toEqual(steps[i])
  }
})

test('gradients on a rectangle, a circle, a path and text match on the canvas, in the PNG and in the SVG', async ({
  page,
}) => {
  const fillType = page.getByRole('group', { name: 'Fill type' })
  const pick = async (kind: 'Linear' | 'Radial') => {
    await fillType.getByRole('button', { name: kind, exact: true }).click()
    await expect(fillType.getByRole('button', { name: kind, exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
  }

  // A rectangle from red to white, left to right.
  await drawRectOnCanvas(page, [100, 100], [500, 300])
  await pick('Linear')
  await page.getByRole('button', { name: 'Stop #ef4444' }).click()
  // A circle from black in the middle to blue.
  await page.keyboard.press('o')
  await page.keyboard.down('Shift')
  await drag(page, await screenOf(page, [700, 100]), await screenOf(page, [950, 350]))
  await page.keyboard.up('Shift')
  await pick('Radial')
  await page.getByRole('slider', { name: 'Stop 2' }).click()
  await page.getByRole('button', { name: 'Stop #3b82f6' }).click()
  // A pen triangle, linear, turned by its end handle.
  await page.keyboard.press('p')
  await page.mouse.click(...(await screenOf(page, [1100, 350])))
  await page.mouse.click(...(await screenOf(page, [1450, 120])))
  await page.mouse.click(...(await screenOf(page, [1500, 420])))
  await page.mouse.click(...(await screenOf(page, [1100, 350])))
  await pick('Linear')
  await dragWith(
    page,
    await overlayPointOf(page, 'gradient-end'),
    await screenOf(page, [1450, 400]),
  )
  // A big text, radial.
  await page.keyboard.press('t')
  await page.mouse.click(...(await screenOf(page, [300, 600])))
  await page.keyboard.type('Gradient')
  await page.keyboard.press('Control+Enter')
  await page.getByRole('slider', { name: 'Font size' }).focus()
  await page.keyboard.press('End')
  await page
    .getByRole('group', { name: 'Color type' })
    .getByRole('button', { name: 'Radial', exact: true })
    .click()
  await expect.poll(() => shownFill(page, 3)).toMatchObject({ priority: 'radial-gradient' })
  // And the page's background, linear, from nothing selected.
  await page.keyboard.press('Escape')
  await page.keyboard.press('Escape')
  await page
    .getByRole('group', { name: 'Background type' })
    .getByRole('button', { name: 'Linear', exact: true })
    .click()
  expect(await shownShapes(page)).toEqual(['Rect', 'Ellipse', 'Path', 'Text'])

  // The PNG has the canvas's gradient: red fading to white across the rectangle.
  const { png, values } = await exportPixels(page, [
    [2 * 140, 2 * 200],
    [2 * 460, 2 * 200],
  ])
  for (const [pixel, f] of [
    [values[0], 0.1],
    [values[1], 0.9],
  ] as const) {
    const expected = [239 + 16 * f, 68 + 187 * f, 68 + 187 * f]
    pixel.slice(0, 3).forEach((c, i) => expect(Math.abs(c - expected[i])).toBeLessThan(8))
  }

  // Drawn by Chrome's SVG renderer, the export looks like the canvas.
  const { text: svg } = await downloadFromFileMenu(page, 'Export SVG')
  expect(svg.match(/<linearGradient /g)).toHaveLength(3)
  expect(svg.match(/<radialGradient /g)).toHaveLength(2)
  expect(svg).toContain('gradientUnits="userSpaceOnUse"')
  const { some, far } = await svgAgainstPng(page, svg, png)
  expect(far).toBeLessThan(200)
  expect(some).toBeLessThan(3200 * 2000 * 0.002)

  // Imported back, the shapes keep their gradients (the text is skipped) and lie over the drawing.
  await chooseFromFileMenu(page, 'Import SVG', 'drawing.svg', svg)
  await expect(page.getByRole('status')).toContainText('Skipped 1 unsupported element')
  const kinds = await page.evaluate(() =>
    (
      (window as unknown as { Konva: typeof Konva }).Konva.stages[0]
        .getLayers()[1]
        .getChildren()[4] as Konva.Group
    )
      .getChildren()
      .map((n) => (n as Konva.Shape).fillPriority()),
  )
  expect(kinds).toEqual(['linear-gradient', 'radial-gradient', 'linear-gradient'])
  const again = await exportPixels(page, [])
  expect((await svgAgainstPng(page, svg, again.png)).far).toBeLessThan(200)
})

/** The canvas box of a shape on the content layer, by its place bottom to top. */
function shapeBox(page: Page, index: number) {
  return page.evaluate((index) => {
    const layer = (window as unknown as { Konva: typeof Konva }).Konva.stages[0].getLayers()[1]
    return layer.getChildren()[index].getClientRect({ relativeTo: layer })
  }, index)
}

/** Whether the page has loaded the lazy chunk that holds Paper.js and the boolean pipeline. */
const paperLoaded = (page: Page) =>
  page.evaluate(() =>
    performance.getEntriesByType('resource').some((entry) => entry.name.includes('booleanOp')),
  )

test('a circle subtracted from a rectangle leaves a node-editable hole, a union takes in a freehand stroke, and Simplify thins it, one undo step each', async ({
  page,
}) => {
  const undo = page.getByRole('button', { name: 'Undo' })
  const redo = page.getByRole('button', { name: 'Redo' })
  // Canvas (400, 300) inside the rectangle, (640, 460) the circle's middle, (1200, 300) outside.
  const pixels = [exportPixel([0.25, 0.3]), exportPixel([0.4, 0.46]), exportPixel([0.75, 0.3])]

  // A blue rectangle from canvas (320, 200) to (960, 700), and a circle of radius 160 inside it.
  await page.keyboard.press('r')
  await drawLine(page, [0.2, 0.2], [0.6, 0.7])
  await page.getByRole('button', { name: 'Fill #3b82f6' }).click()
  await page.keyboard.press('o')
  await drawLine(page, [0.3, 0.3], [0.5, 0.62])
  expect(await paperLoaded(page)).toBe(false)

  // Ctrl + Alt + S subtracts the circle; Paper loads only now.
  await page.keyboard.press('Control+a')
  await expect(page.getByRole('group', { name: 'Combine' })).toBeVisible()
  await page.keyboard.press('Control+Alt+s')
  await expect.poll(() => shownShapes(page)).toEqual(['Path'])
  expect(await paperLoaded(page)).toBe(true)
  expect((await exportPixels(page, pixels)).values).toEqual([BLUE, WHITE, WHITE])
  await expect
    .poll(async () =>
      (await savedNodes(page)).map((node) => {
        const n = node as { type?: string; contours?: unknown[] }
        return [n.type, n.contours?.length]
      }),
    )
    .toEqual([['path', 2]])

  // Both contours are node-editable: the rectangle's 4 anchors and the hole's 4.
  await page.keyboard.press('a')
  await expect.poll(() => anchorCount(page)).toBe(8)
  await page.keyboard.press('v')

  // One undo step, and back.
  await undo.click()
  expect(await shownShapes(page)).toEqual(['Rect', 'Ellipse'])
  await redo.click()
  expect(await shownShapes(page)).toEqual(['Path'])

  // A freehand stroke from inside the rectangle out past its right side, at canvas y 650.
  await page.keyboard.press('b')
  await drawLine(page, [0.5, 0.65], [0.9, 0.65])
  expect(await shownShapes(page)).toEqual(['Path', 'Path'])
  expect((await shapeBox(page, 0)).x + (await shapeBox(page, 0)).width).toBeLessThan(970)

  // Union from the canvas's right-click menu: the path takes the stroke in, in its own style.
  await page.keyboard.press('Control+a')
  const box = await artboardBox(page)
  await page.mouse.click(...onArtboard(box, [0.25, 0.3]), { button: 'right' })
  await expect(page.getByRole('menuitem', { name: 'Simplify path' })).toBeEnabled()
  await page.getByRole('menuitem', { name: 'Union' }).click()
  await expect.poll(() => shownShapes(page)).toEqual(['Path'])
  const united = await shapeBox(page, 0)
  expect(united.x + united.width).toBeGreaterThan(1430)
  expect((await exportPixels(page, [exportPixel([0.85, 0.65])])).values[0]).not.toEqual(WHITE)
  await undo.click()
  expect(await shownShapes(page)).toEqual(['Path', 'Path'])
  await redo.click()
  expect(await shownShapes(page)).toEqual(['Path'])

  // Simplify, from the panel's button: the stroke's anchors thin out, as one undo step.
  await page.keyboard.press('a')
  const before = await anchorCount(page)
  await page.getByRole('button', { name: 'Simplify path' }).click()
  await expect(page.getByRole('status')).toContainText(`Simplified from ${before} anchors to`)
  const after = await anchorCount(page)
  expect(after).toBeLessThan(before)
  expect((await shapeBox(page, 0)).width).toBeCloseTo(united.width, -1)
  await undo.click()
  expect(await anchorCount(page)).toBe(before)

  // A text can't be combined: the Combine buttons are disabled.
  await page.keyboard.press('t')
  await page.mouse.click(...onArtboard(box, [0.8, 0.2]))
  await page.keyboard.type('Hi')
  await page.keyboard.press('Control+Enter')
  await page.keyboard.press('Control+a')
  await expect(page.getByRole('button', { name: 'Union' })).toBeDisabled()
})

/**
 * Makes an 8000 × 6000 JPEG of four colored quarters, red, green, blue and yellow from the top
 * left, under fine noise so it weighs as much as a phone photo, and keeps it in the page as
 * `window.photo`. Returns its size in bytes.
 */
function makePhoto(page: Page) {
  return page.evaluate(async () => {
    const [w, h] = [8000, 6000]
    const canvas = new OffscreenCanvas(w, h)
    const ctx = canvas.getContext('2d')!
    const quarters = ['#ef4444', '#22c55e', '#3b82f6', '#eab308']
    quarters.forEach((color, i) => {
      ctx.fillStyle = color
      ctx.fillRect((i % 2) * (w / 2), Math.floor(i / 2) * (h / 2), w / 2, h / 2)
    })
    const tile = new ImageData(500, 500)
    for (let i = 0; i < tile.data.length; i += 4) {
      const v = Math.random() * 255
      tile.data.set([v, v, v, 24], i)
    }
    const noise = new OffscreenCanvas(500, 500)
    noise.getContext('2d')!.putImageData(tile, 0, 0)
    for (let y = 0; y < h; y += 500) for (let x = 0; x < w; x += 500) ctx.drawImage(noise, x, y)
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.98 })
    const win = window as unknown as { photo: File }
    win.photo = new File([blob], 'photo.jpg', { type: 'image/jpeg' })
    return blob.size
  })
}

/** Which quarter's color an RGBA value is, roughly: the photo's JPEG and noise shift them. */
function colorOf([r, g, b]: number[]): string {
  if (r > 200 && g > 200 && b > 200) return 'white'
  if (r > 150 && g > 120 && b < 100) return 'yellow'
  if (r > g + 60 && r > b + 60) return 'red'
  if (g > r + 60 && g > b + 40) return 'green'
  if (b > r + 60 && b > g + 40) return 'blue'
  return `rgb(${r}, ${g}, ${b})`
}

/** Whether every image on the content layer has its bytes decoded and drawn, not a gray box. */
const imagesDrawn = (page: Page) =>
  page.evaluate(() =>
    (window as unknown as { Konva: typeof Konva }).Konva.stages[0]
      .getLayers()[1]
      .find('Image')
      .every((image) => (image as Konva.Image).image() !== undefined),
  )

/** The asset ids IndexedDB holds bytes for, from their asset:<sha256> keys, sorted. */
function storedAssets(page: Page) {
  return page.evaluate(
    () =>
      new Promise<string[]>((resolve) => {
        const open = indexedDB.open('painter')
        open.onsuccess = () => {
          const request = open.result.transaction('kv').objectStore('kv').getAllKeys()
          request.onsuccess = () => {
            open.result.close()
            resolve(
              request.result
                .map(String)
                .filter((key) => key.startsWith('asset:'))
                .map((key) => key.slice('asset:'.length))
                .sort(),
            )
          }
        }
      }),
  )
}

type SavedAsset = { id: string; mime: string; width: number; height: number; bytes: number }
type SavedImage = { width: number; height: number; transform: Transform }

/** The autosaved doc's asset records, and its first page's images, bottom to top. */
async function savedImages(page: Page) {
  const doc = (await savedDoc(page)) as unknown as {
    pages: { rootIds: string[] }[]
    nodes: Record<string, SavedImage>
    assets: Record<string, SavedAsset>
  } | null
  return {
    assets: Object.values(doc?.assets ?? {}),
    images: doc ? doc.pages[0].rootIds.map((id) => doc.nodes[id]) : [],
  }
}

test('a 20 MB photo imports without freezing, crops in the PNG and the SVG, and survives a refresh and a .painter round trip', async ({
  page,
  browser,
}) => {
  test.setTimeout(120_000)
  const undo = page.getByRole('button', { name: 'Undo' })
  const redo = page.getByRole('button', { name: 'Redo' })
  expect(await makePhoto(page)).toBeGreaterThan(20_000_000)

  // Dropped on the canvas while the main thread is watched: decoding, scaling down and hashing
  // happen in a worker, so no task holds the page up for long.
  const longest = await page.evaluate(async () => {
    const tasks: number[] = []
    const observer = new PerformanceObserver((list) =>
      list.getEntries().forEach((entry) => tasks.push(entry.duration)),
    )
    observer.observe({ type: 'longtask' })
    const data = new DataTransfer()
    data.items.add((window as unknown as { photo: File }).photo)
    const canvas = document.querySelector('[data-file-drop]')!
    canvas.dispatchEvent(new DragEvent('dragover', { dataTransfer: data, bubbles: true }))
    canvas.dispatchEvent(new DragEvent('drop', { dataTransfer: data, bubbles: true }))
    const stage = (window as unknown as { Konva: typeof Konva }).Konva.stages[0]
    const drawn = () => (stage.getLayers()[1].findOne('Image') as Konva.Image | undefined)?.image()
    while (!drawn()) await new Promise((resolve) => setTimeout(resolve, 20))
    await new Promise((resolve) => setTimeout(resolve, 500))
    observer.disconnect()
    return Math.max(0, ...tasks)
  })
  expect(longest).toBeLessThan(250)
  expect(await shownShapes(page)).toEqual(['Image'])
  await expect(page.getByRole('button', { name: 'Select', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await expect(page.getByRole('heading', { name: 'photo' })).toBeVisible()

  // Scaled down to 4096 px and saved again as a JPEG, stored once by its SHA-256, and placed in
  // the middle of the page within 80% of it: 1066.67 × 800 at (266.67, 100).
  await expect.poll(async () => (await savedImages(page)).images.length).toBe(1)
  const {
    assets: [asset],
    images: [placed],
  } = await savedImages(page)
  expect(asset).toMatchObject({ mime: 'image/jpeg', width: 4096, height: 3072 })
  expect(asset.id).toMatch(/^[0-9a-f]{64}$/)
  expect(await storedAssets(page)).toEqual([asset.id])
  expect(placed.width).toBeCloseTo(1066.67, 1)
  expect(placed.height).toBe(800)
  expect(placed.transform.x).toBeCloseTo(266.67, 1)
  expect(placed.transform.y).toBe(100)

  // Enter opens crop mode; the left handle dragged to the middle crops the left half away, and
  // Enter applies it, as one undo step.
  await page.keyboard.press('Enter')
  await expect(page.getByRole('heading', { name: 'Crop image' })).toBeVisible()
  const box = await artboardBox(page)
  const left = await overlayPointOf(page, 'crop-middle-left')
  await drag(page, left, [onArtboard(box, [0.5, 0])[0], left[1]])
  await page.keyboard.press('Enter')
  await expect(page.getByRole('heading', { name: 'photo' })).toBeVisible()
  expect((await shownAttr(page, 'cropX'))[0]).toBeCloseTo(2048, -1)
  expect((await shownAttr(page, 'width'))[0]).toBeCloseTo(533.33, -1)
  await undo.click()
  expect(await shownAttr(page, 'cropWidth')).toEqual([0])
  await redo.click()
  expect((await shownAttr(page, 'cropWidth'))[0]).toBeCloseTo(2048, -1)

  // The PNG shows only the right half, where it lay: green above, yellow below, white where the
  // left half was.
  const points = [
    exportPixel([0.6, 0.3]),
    exportPixel([0.6, 0.8]),
    exportPixel([0.78, 0.2]),
    exportPixel([0.3, 0.3]),
    exportPixel([0.3, 0.8]),
  ]
  const expected = ['green', 'yellow', 'green', 'white', 'white']
  const { png, values } = await exportPixels(page, points)
  expect(values.map(colorOf)).toEqual(expected)

  // The SVG holds the photo as a data: URL, cropped by a nested <svg>, and draws as the PNG.
  const svg = await downloadFromFileMenu(page, 'Export SVG')
  expect(svg.text).toContain('xmlns:xlink="http://www.w3.org/1999/xlink"')
  expect(svg.text).toMatch(
    /<g transform="[^"]+"><svg width="[\d.]+" height="800" viewBox="[\d.]+ 0 [\d.]+ 3072" preserveAspectRatio="none"><image width="4096" height="3072" xlink:href="data:image\/jpeg;base64,/,
  )
  const { some, far } = await svgAgainstPng(page, svg.text, png)
  // The photo's right edge falls 2/3 into export column 2666 (1333.33 canvas units): canvas
  // paints that column with the photo, SVG anti-aliases it, so its 1600 pixels may differ.
  expect(far).toBeLessThan(1600 + 200)
  expect(some).toBeLessThan(3200 * 2000 * 0.01)

  // A refresh brings it back from IndexedDB, cropped.
  await page.reload()
  await waitForCanvas(page)
  await expect.poll(() => imagesDrawn(page)).toBe(true)
  expect((await exportPixels(page, points)).values.map(colorOf)).toEqual(expected)

  // Saved as a .painter file, the photo goes in once, under its hash.
  const file = await downloadBytesFromFileMenu(page, 'Save')
  expect(file.name).toBe('drawing.painter')
  const { doc: inFile, others, entries } = readPainter(file.bytes)
  expect(others).toEqual([`assets/${asset.id}.jpg`])
  expect(entries[`assets/${asset.id}.jpg`].length).toBe(asset.bytes)
  expect(Object.keys(inFile.assets)).toEqual([asset.id])

  // Opened in a fresh browser, with nothing stored, it looks the same, and is stored there.
  const fresh = await browser.newContext()
  const other = await fresh.newPage()
  await other.goto('/')
  await waitForCanvas(other)
  const chooser = other.waitForEvent('filechooser')
  await fromFileMenu(other, 'Open')
  await (
    await chooser
  ).setFiles({ name: 'drawing.painter', mimeType: 'application/octet-stream', buffer: file.bytes })
  await expect.poll(() => shownShapes(other)).toEqual(['Image'])
  await expect.poll(() => imagesDrawn(other)).toBe(true)
  expect((await exportPixels(other, points)).values.map(colorOf)).toEqual(expected)
  await expect.poll(() => storedAssets(other)).toEqual([asset.id])
  await fresh.close()
})

/** A small PNG of one color made in the page, as bytes. */
async function smallPng(page: Page, color: string): Promise<Buffer> {
  const base64 = await page.evaluate((color) => {
    const canvas = document.createElement('canvas')
    canvas.width = 120
    canvas.height = 80
    const ctx = canvas.getContext('2d')!
    ctx.fillStyle = color
    ctx.fillRect(0, 0, 120, 80)
    return canvas.toDataURL('image/png').split(',')[1]
  }, color)
  return Buffer.from(base64, 'base64')
}

/** Pastes a file as the browser does after Ctrl+V when the clipboard holds one. */
function pasteFile(page: Page, name: string, type: string, bytes: Buffer) {
  return page.evaluate(
    ({ name, type, base64 }) => {
      const data = new DataTransfer()
      const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
      data.items.add(new File([bytes], name, { type }))
      document.dispatchEvent(
        new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
      )
    },
    { name, type, base64: bytes.toString('base64') },
  )
}

test('images come in by the picker and by paste, are stored once, and leave storage once deleted', async ({
  page,
}) => {
  const red = await smallPng(page, '#ef4444')
  const blue = await smallPng(page, '#3b82f6')

  // File → Import image… takes images and SVG files, several at once.
  const chooser = page.waitForEvent('filechooser')
  await fromFileMenu(page, 'Import image…')
  await (
    await chooser
  ).setFiles([
    { name: 'red.png', mimeType: 'image/png', buffer: red },
    {
      name: 'square.svg',
      mimeType: 'image/svg+xml',
      buffer: Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect x="5" y="5" width="30" height="30" fill="#22c55e"/></svg>',
      ),
    },
  ])
  await expect.poll(() => shownShapes(page)).toEqual(['Image', 'Group'])
  await expect.poll(() => imagesDrawn(page)).toBe(true)
  // Small enough, it keeps its size, in the middle of the page.
  expect((await shownAttr(page, 'width'))[0]).toBe(120)
  expect((await shownTransforms(page))[0]).toMatchObject({ x: 740, y: 460 })

  // Pasted: the same image again is stored once, a new one is added.
  await pasteFile(page, 'image.png', 'image/png', red)
  await expect.poll(() => shownShapes(page)).toEqual(['Image', 'Group', 'Image'])
  await pasteFile(page, 'image.png', 'image/png', blue)
  await expect.poll(() => shownShapes(page)).toEqual(['Image', 'Group', 'Image', 'Image'])
  await expect.poll(async () => (await storedAssets(page)).length).toBe(2)
  const both = await storedAssets(page)
  await expect.poll(() => imagesDrawn(page)).toBe(true)
  expect((await exportPixels(page, [exportPixel([0.5, 0.5])])).values.map(colorOf)).toEqual([
    'blue',
  ])

  // Copied in the editor, the selected image pastes as an object, offset.
  await page.keyboard.press('Control+c')
  await page.keyboard.press('Control+v')
  await expect.poll(() => shownShapes(page)).toHaveLength(5)
  expect((await shownTransforms(page))[4]).toMatchObject({ x: 750, y: 470 })

  // A file that isn't an image says so, and changes nothing.
  await pasteFile(page, 'notes.png', 'image/png', Buffer.from('hello'))
  await expect(page.getByRole('status')).toHaveText("notes.png isn't a PNG, JPEG or WebP image.")
  expect(await shownShapes(page)).toHaveLength(5)

  // Deleted, the images' bytes stay while undo can bring them back; the next start, which has
  // no undo history, lets them go.
  await page.keyboard.press('Control+a')
  await page.keyboard.press('Delete')
  await expect.poll(async () => (await savedImages(page)).images.length).toBe(0)
  expect(await storedAssets(page)).toEqual(both)
  await page.reload()
  await waitForCanvas(page)
  await expect.poll(() => storedAssets(page)).toEqual([])
})

/** Whether the page has loaded the lazy chunk that holds jsPDF, svg2pdf.js and the PDF export. */
const pdfLoaded = (page: Page) =>
  page.evaluate(() =>
    performance.getEntriesByType('resource').some((entry) => entry.name.includes('exportPdf')),
  )

/**
 * Each path a PDF content stream paints or clips by: how many subpaths it has (m, or re) and the
 * operator that ends it (f, S, W n, …), in drawing order.
 */
function pdfPaths(content: string) {
  const out: { subpaths: number; end: string }[] = []
  let subpaths = 0
  for (const line of content.split('\n')) {
    if (/ (m|re)$/.test(line)) subpaths++
    else if (/^(f\*?|S|B\*?|b\*?|n|W\*? [nS])$/.test(line)) {
      if (subpaths > 0) out.push({ subpaths, end: line })
      subpaths = 0
    }
  }
  return out
}

/** Opens File → Export PDF…, sets it up, exports, and returns the file's name and its contents. */
async function exportPdfFromDialog(
  page: Page,
  { range, mode }: { range?: string; mode?: 'Vector' | 'Image' } = {},
) {
  await fromFileMenu(page, 'Export PDF…')
  const dialog = page.getByRole('dialog', { name: 'Export PDF' })
  await expect(dialog).toBeVisible()
  if (range !== undefined) {
    await dialog.getByRole('radio', { name: 'Pages', exact: true }).check()
    await dialog.getByRole('textbox', { name: 'Page range' }).fill(range)
  }
  if (mode) await dialog.getByRole('radio', { name: new RegExp(`^${mode}`) }).check()
  const downloadPromise = page.waitForEvent('download')
  await dialog.getByRole('button', { name: 'Export' }).click()
  const download = await downloadPromise
  await expect(dialog).toHaveCount(0)
  return { name: download.suggestedFilename(), pdf: readPdf(await readFile(await download.path())) }
}

const A4 = [595.5, 842.25] // pt: 794 × 1123 px × 0.75

test('release: pages, snapping, a gradient, a boolean, an image and text export as a 3-page A4 PDF with selectable text', async ({
  page,
}) => {
  const pages = page.getByRole('complementary', { name: 'Pages' })
  const font = page.getByRole('combobox', { name: 'Font' })
  const placeText = async (at: Xy, words: string) => {
    await page.mouse.click(...(await screenOf(page, at)))
    await expect(page.getByRole('textbox', { name: 'Text' })).toBeFocused()
    await page.keyboard.type(words)
    await page.keyboard.press('Control+Enter')
    await expect(page.getByRole('textbox', { name: 'Text' })).toHaveCount(0)
  }

  // Page 1 becomes A4 from the page's size presets.
  await page.keyboard.press('v')
  await page.getByRole('combobox', { name: 'Page size' }).selectOption('a4')
  await expect.poll(() => pageRatio(page)).toBe(0.71)

  // A rectangle dropped 3 screen px from the page's top-left corner snaps its ink onto both edges.
  await drawRectOnCanvas(page, [100, 100], [400, 300])
  const zoom = await zoomOf(page)
  const guides = await dragOnCanvas(page, [250, 200], [-98 * zoom + 3, -98 * zoom + 3])
  expect(guides).toHaveLength(2)
  const [placed] = await shownTransforms(page)
  expect(placed.x).toBeCloseTo(2, 6)
  expect(placed.y).toBeCloseTo(2, 6)

  // A linear gradient from the panel, then a circle subtracted from it: a path with a hole.
  await page
    .getByRole('group', { name: 'Fill type' })
    .getByRole('button', { name: 'Linear', exact: true })
    .click()
  expect((await shownFill(page)).priority).toBe('linear-gradient')
  await page.keyboard.press('o')
  await drag(page, await screenOf(page, [80, 50]), await screenOf(page, [220, 190]))
  expect(await pdfLoaded(page)).toBe(false)
  await page.keyboard.press('Control+a')
  await page.keyboard.press('Control+Alt+s')
  await expect.poll(() => shownShapes(page)).toEqual(['Path'])
  expect((await shownFill(page)).priority).toBe('linear-gradient')

  // A text in Georgia, which the PDF embeds as Gelasio.
  await page.keyboard.press('t')
  await font.selectOption({ label: 'Georgia' })
  await placeText([60, 500], 'Georgia on page one')

  // Page 2: an image from the picker, its left half cropped away.
  await pages.getByRole('button', { name: 'Add page' }).click()
  expect(await pageNames(page)).toEqual(['Page 1', 'Page 2*'])
  const chooser = page.waitForEvent('filechooser')
  await fromFileMenu(page, 'Import image…')
  await (
    await chooser
  ).setFiles({ name: 'red.png', mimeType: 'image/png', buffer: await smallPng(page, '#ef4444') })
  await expect.poll(() => shownShapes(page)).toEqual(['Image'])
  await expect.poll(() => imagesDrawn(page)).toBe(true)
  await page.keyboard.press('Enter')
  const left = await overlayPointOf(page, 'crop-middle-left')
  const middle = await screenOf(page, [397, 0])
  await drag(page, left, [middle[0], left[1]])
  await page.keyboard.press('Enter')
  expect((await shownAttr(page, 'cropX'))[0]).toBeCloseTo(60, 0)

  // Page 3: a text in Arial.
  await pages.getByRole('button', { name: 'Add page' }).click()
  await page.keyboard.press('t')
  await font.selectOption({ label: 'Arial' })
  await placeText([60, 200], 'Arial on page three')

  // All three pages, as vectors, by default; the PDF code loads only when one is made.
  await fromFileMenu(page, 'Export PDF…')
  const dialog = page.getByRole('dialog', { name: 'Export PDF' })
  await expect(dialog.getByRole('radio', { name: 'All 3 pages' })).toBeChecked()
  await expect(dialog.getByRole('radio', { name: /^Vector/ })).toBeChecked()
  await expect(dialog.getByRole('list', { name: 'Warnings' })).toHaveCount(0)
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(dialog).toHaveCount(0)
  expect(await pdfLoaded(page)).toBe(false)
  const { name, pdf } = await exportPdfFromDialog(page)
  expect(await pdfLoaded(page)).toBe(true)
  expect(name).toBe('drawing.pdf')

  // Three A4 pages, each with its own text as text a viewer selects.
  expect(pdf.pages.map((p) => [p.width, p.height])).toEqual([A4, A4, A4])
  expect(pdf.pages.map((p) => p.text)).toEqual([
    ['Georgia on page one'],
    [],
    ['Arial on page three'],
  ])
  const gelasio = (d: string) => /\/BaseFont \/Gelasio/.test(d) && /\/Subtype \/Type0/.test(d)
  expect(pdf.objects.some(gelasio)).toBe(true)
  expect(pdf.objects.some((d) => /\/FontFile2/.test(d))).toBe(true)

  // Page 1: the gradient is a shading that fills the boolean shape's two contours, hole and all,
  // and its outline goes over it.
  expect(pdf.objects.some((d) => /\/ShadingType 2/.test(d))).toBe(true)
  const paths = pdfPaths(pdf.pages[0].content)
  expect(paths).toContainEqual({ subpaths: 2, end: 'W n' })
  expect(paths).toContainEqual({ subpaths: 2, end: 'S' })
  expect(pdf.pages[0].content).toMatch(/\/Sh\d+ sh/)

  // Page 2: the image, clipped to its crop by a rectangle.
  expect(pdf.pages[1].content).toMatch(/ re\nW\nn\n[\s\S]*\/I\d+ Do/)
  const png = (d: string) => /\/Subtype \/Image/.test(d) && /\/Width 120\b/.test(d)
  expect(pdf.objects.some(png)).toBe(true)

  // Page 2 alone in image mode: one A4 page, a 300 dpi JPEG and no text.
  const image = await exportPdfFromDialog(page, { range: '2', mode: 'Image' })
  expect(image.pdf.pages.map((p) => [p.width, p.height])).toEqual([A4])
  expect(image.pdf.pages[0].text).toEqual([])
  const jpegs = image.pdf.objects.filter((d) => /\/Filter \/DCTDecode/.test(d))
  expect(jpegs).toHaveLength(1)
  expect(jpegs[0]).toMatch(/\/Width 2481\b/)
  expect(jpegs[0]).toMatch(/\/Height 3509\b/)
})

test('the PDF dialog checks page ranges, warns about fonts, draws pages it must as images, and keeps its keys from the canvas', async ({
  page,
}) => {
  const text = (id: string, words: string, fontFamily: string) => ({
    id,
    type: 'text',
    name: 'Text',
    parentId: null,
    transform: { x: 100, y: 100, rotation: 0, scaleX: 1, scaleY: 1 },
    style: { fill: { kind: 'solid', color: '#000000' }, stroke: null, strokeWidth: 0, opacity: 1 },
    hidden: false,
    locked: false,
    text: words,
    fontFamily,
    fontSize: 40,
    fontStyle: 'normal',
    align: 'left',
    width: 600,
  })
  const pageOf = (id: string, name: string, rootIds: string[], width = 1123, height = 794) => ({
    id,
    name,
    width,
    height,
    background: { kind: 'solid', color: '#ffffff' },
    rootIds,
  })
  await putSaved(page, 'painter:v3', {
    version: 3,
    pages: [
      pageOf('p1', 'Cover', ['a']),
      pageOf('p2', 'Arabic', ['b'], 794, 1123),
      pageOf('p3', 'Back', ['c']),
    ],
    nodes: {
      a: text('a', 'Verdana words', 'Verdana, Geneva, sans-serif'),
      b: text('b', 'مرحبا', 'Arial, Helvetica, sans-serif'),
      c: text('c', 'Back page', 'Times New Roman, Times, serif'),
    },
    assets: {},
  })
  await page.reload()
  await waitForCanvas(page)
  expect(await pageNames(page)).toEqual(['Cover*', 'Arabic', 'Back'])

  // A text selected on the canvas stays put whatever is pressed in the dialog.
  await page.keyboard.press('v')
  await page.keyboard.press('Control+a')
  expect(await selectedCount(page)).toBe(1)
  await fromFileMenu(page, 'Export PDF…')
  const dialog = page.getByRole('dialog', { name: 'Export PDF' })
  const warnings = dialog.getByRole('list', { name: 'Warnings' }).getByRole('listitem')
  await expect(warnings).toHaveText([
    "Verdana isn't a PDF font, so page 1 shows it in Helvetica.",
    "Page 2 has characters the PDF's fonts can't show, such as Arabic, Chinese or emoji, so it is drawn as an image, without selectable text.",
  ])
  await dialog.getByRole('button', { name: 'Cancel' }).focus()
  await page.keyboard.press('Delete')
  await page.keyboard.press('b')

  // Image mode draws every page as an image: nothing to warn about.
  await dialog.getByRole('radio', { name: /^Image/ }).check()
  await expect(warnings).toHaveCount(0)
  await dialog.getByRole('radio', { name: /^Vector/ }).check()

  // A range starts at the current page, says what is wrong with it, and narrows the warnings.
  const exportButton = dialog.getByRole('button', { name: 'Export' })
  const range = dialog.getByRole('textbox', { name: 'Page range' })
  await dialog.getByRole('radio', { name: 'Pages', exact: true }).check()
  await expect(range).toHaveValue('1')
  await range.fill('2-5')
  await expect(dialog.getByText("Page 5 doesn't exist: pages run from 1 to 3.")).toBeVisible()
  await expect(range).toHaveAttribute('aria-invalid', 'true')
  await expect(exportButton).toBeDisabled()
  await range.fill('3-1')
  await expect(dialog.getByText('3-1 runs backwards; write it as 1-3.')).toBeVisible()
  await range.fill('1, 3')
  await expect(exportButton).toBeEnabled()
  await expect(warnings).toHaveText(["Verdana isn't a PDF font, so page 1 shows it in Helvetica."])

  // Esc closes it without a download; the canvas never saw the keys.
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Select', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  expect(await shownShapes(page)).toEqual(['Text'])
  expect(await selectedCount(page)).toBe(1)

  // Pages 1 and 3 as vectors, each at its own landscape size, text selectable; Verdana's text
  // is set in Helvetica.
  const both = await exportPdfFromDialog(page, { range: '1, 3' })
  expect(both.pdf.pages.map((p) => [p.width, p.height])).toEqual([
    [842.25, 595.5],
    [842.25, 595.5],
  ])
  expect(both.pdf.pages.map((p) => p.text)).toEqual([['Verdana words'], ['Back page']])
  expect(both.pdf.objects.some((d) => /\/BaseFont \/Helvetica\b/.test(d))).toBe(true)

  // Page 2 in vector mode is still drawn as an image, as on screen: portrait, no text.
  const arabic = await exportPdfFromDialog(page, { range: '2' })
  expect(arabic.pdf.pages.map((p) => [p.width, p.height])).toEqual([A4])
  expect(arabic.pdf.pages[0].text).toEqual([])
  expect(arabic.pdf.objects.some((d) => /\/Filter \/DCTDecode/.test(d))).toBe(true)
})

test.describe('the PDF dialog on a 375 px phone', () => {
  test.use({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true })

  test('opens from the file menu by touch, fits the screen and exports', async ({ page }) => {
    await page.getByRole('button', { name: 'File', exact: true }).tap()
    await page.getByRole('menuitem', { name: 'Export PDF…' }).tap()
    const dialog = page.getByRole('dialog', { name: 'Export PDF' })
    const box = (await dialog.boundingBox())!
    expect(box.x).toBeGreaterThanOrEqual(0)
    expect(box.x + box.width).toBeLessThanOrEqual(375)
    expect(box.y + box.height).toBeLessThanOrEqual(812)
    const exportButton = dialog.getByRole('button', { name: 'Export' })
    expect((await exportButton.boundingBox())!.height).toBeGreaterThanOrEqual(36)
    const downloadPromise = page.waitForEvent('download')
    await exportButton.tap()
    const pdf = readPdf(await readFile(await (await downloadPromise).path()))
    expect(pdf.pages.map((p) => [p.width, p.height])).toEqual([[1200, 750]])
  })
})
