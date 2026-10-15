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

/** Number of nodes in the autosaved doc in IndexedDB; -1 when it can't be read. */
function savedNodeCount(page: Page) {
  return page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        const open = indexedDB.open('painter')
        // Never create the database here: the app's own first open has to do that.
        open.onupgradeneeded = () => open.transaction?.abort()
        open.onerror = () => resolve(-1)
        open.onsuccess = () => {
          const db = open.result
          const request = db.transaction('kv').objectStore('kv').get('painter:v2')
          request.onsuccess = () => {
            db.close()
            resolve(request.result?.rootIds.length ?? 0)
          }
          request.onerror = () => {
            db.close()
            resolve(-1)
          }
        }
      }),
  )
}

/** Clicks Export PNG and returns the downloaded file with the RGBA values at the given pixels. */
async function exportPixels(page: Page, pixels: [number, number][]) {
  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Export PNG' }).click()
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
