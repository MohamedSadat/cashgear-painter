import { expect, test, type Page } from '@playwright/test'
import type Konva from 'konva'
import { readFile } from 'node:fs/promises'

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

type SavedDoc = { rootIds: string[]; nodes: Record<string, { transform: Transform }> }
type Transform = { x: number; y: number; rotation: number; scaleX: number; scaleY: number }

/** The autosaved doc in IndexedDB: null when nothing is saved, undefined when it can't be read. */
function savedDoc(page: Page) {
  return page.evaluate(
    () =>
      new Promise<SavedDoc | null | undefined>((resolve) => {
        const open = indexedDB.open('painter')
        // Never create the database here: the app's own first open has to do that.
        open.onupgradeneeded = () => open.transaction?.abort()
        open.onerror = () => resolve(undefined)
        open.onsuccess = () => {
          const db = open.result
          const request = db.transaction('kv').objectStore('kv').get('painter:v2')
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
  )
}

/** Number of nodes in the autosaved doc in IndexedDB; -1 when it can't be read. */
async function savedNodeCount(page: Page) {
  const doc = await savedDoc(page)
  return doc === undefined ? -1 : (doc?.rootIds.length ?? 0)
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

  // Migration is not an undo step, and it is saved as v2 right away.
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
  const zoomLabel = page.getByRole('button', { name: 'Fit artboard' })
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
  const zoomLabel = page.getByRole('button', { name: 'Fit artboard' })
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
  const zoomLabel = page.getByRole('button', { name: 'Fit artboard' })
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

  // Down by 100 canvas units.
  await drag(page, onArtboard(box, [0.4, 0.5]), onArtboard(box, [0.4, 0.6]))
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
  const fill = page.getByRole('group', { name: 'Fill' })
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

  // Shapes are saved and come back after a reload.
  await expect.poll(() => savedNodeCount(page)).toBe(2)
  await page.reload()
  await waitForCanvas(page)
  expect(await shownShapes(page)).toEqual(['Rect', 'Ellipse'])
  expect((await exportPixels(page, inside)).values).toEqual([RED, BLUE])
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
  await page.getByRole('button', { name: 'Duplicate' }).click()
  expect(await shownShapes(page)).toEqual(['Rect', 'Ellipse', 'Ellipse'])
  await page.getByRole('button', { name: 'Delete' }).click()
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
      await page.getByRole('button', { name: tool }).tap()
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
        /^anchor-\d+$/.test(n.name()),
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
  await drag(page, await overlayPointOf(page, 'handle-out-1'), onArtboard(box, [0.3, 0]))
  expect((await exportPixels(page, [aboveLobe])).values).toEqual([RED])
  const [taller] = (await shownAttr(page, 'data')) as string[]

  // Alt-drag moves one handle of the smooth right lobe and leaves the other alone.
  const otherHandle = await overlayPointOf(page, 'handle-in-3')
  await page.keyboard.down('Alt')
  await drag(page, await overlayPointOf(page, 'handle-out-3'), onArtboard(box, [0.8, 0.6]))
  await page.keyboard.up('Alt')
  expect(await overlayPointOf(page, 'handle-in-3')).toEqual(otherHandle)
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
    const handle = await overlayPointOf(page, 'handle-out-1')
    const twin = await overlayPointOf(page, 'handle-in-1')
    await finger.drag(handle, [handle[0], handle[1] + 60])
    expect(await shownAttr(page, 'data')).not.toEqual(drawn)
    // The smooth anchor's other handle swings to stay in line.
    expect(await overlayPointOf(page, 'handle-in-1')).not.toEqual(twin)

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

  // Text is saved and comes back after a reload.
  await expect.poll(() => savedNodeCount(page)).toBe(1)
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

test('save and open a .painter.json drawing; Open is one undo step and refuses unknown versions', async ({
  page,
}) => {
  const undo = page.getByRole('button', { name: 'Undo' })
  const redo = page.getByRole('button', { name: 'Redo' })
  await drawLine(page, [0.1, 0.6], [0.4, 0.9])
  await page.getByRole('button', { name: 'Rectangle' }).click()
  await drawLine(page, [0.1, 0.1], [0.3, 0.3])
  const drawn = await shownAttr(page, 'x')

  const saved = await downloadFromFileMenu(page, 'Save')
  expect(saved.name).toBe('drawing.painter.json')
  const doc = JSON.parse(saved.text)
  expect(doc).toMatchObject({ version: 2, width: 1600, height: 1000, background: '#ffffff' })
  expect(doc.rootIds).toHaveLength(2)

  // Ctrl+S saves too, instead of the browser saving the page.
  const viaKeys = page.waitForEvent('download')
  await page.keyboard.press('Control+s')
  expect((await viaKeys).suggestedFilename()).toBe('drawing.painter.json')

  await page.getByRole('button', { name: 'Clear' }).click()
  expect(await shownShapes(page)).toEqual([])

  // Ctrl+O opens the file picker, as File → Open does.
  const chooser = page.waitForEvent('filechooser')
  await page.keyboard.press('Control+o')
  await (
    await chooser
  ).setFiles({
    name: 'drawing.painter.json',
    mimeType: 'application/json',
    buffer: Buffer.from(saved.text),
  })
  await expect.poll(() => shownShapes(page)).toEqual(['Path', 'Rect'])
  expect(await shownAttr(page, 'x')).toEqual(drawn)

  // Opening replaced the drawing in one step: undo brings back the cleared canvas.
  await undo.click()
  expect(await shownShapes(page)).toEqual([])
  await redo.click()
  expect(await shownShapes(page)).toEqual(['Path', 'Rect'])

  // A file from a newer version, or not a drawing at all, changes nothing.
  const future = JSON.stringify({ ...doc, version: 3 })
  await chooseFromFileMenu(page, 'Open', 'future.painter.json', future)
  await expect(page.getByRole('status')).toHaveText('This drawing is from an unknown version (3).')
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
