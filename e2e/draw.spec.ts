import { expect, test, type Page } from '@playwright/test'
import { readFile } from 'node:fs/promises'

const WHITE = [255, 255, 255, 255]
const BLACK = [0, 0, 0, 255]

async function drawLine(page: Page, from: [number, number], to: [number, number]) {
  const box = await page.getByTestId('canvas').boundingBox()
  if (!box) throw new Error('canvas not visible')
  const at = ([fx, fy]: [number, number]) =>
    [box.x + box.width * fx, box.y + box.height * fy] as const

  await page.mouse.move(...at(from))
  await page.mouse.down()
  for (let i = 1; i <= 12; i++) {
    const t = i / 12
    await page.mouse.move(...at([from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t]))
  }
  await page.mouse.up()
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

/** Waits until the Stage has mounted its three layer canvases (background, content, cursor). */
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
