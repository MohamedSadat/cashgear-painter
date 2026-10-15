import { expect, test, type Page } from '@playwright/test'
import { readFile } from 'node:fs/promises'

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

/** Number of painted pixels on the strokes layer (the second of Konva's layer canvases). */
function paintedPixels(page: Page) {
  return page.evaluate(() => {
    const canvas = document.querySelectorAll<HTMLCanvasElement>('[data-testid=canvas] canvas')[1]
    const { data } = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height)
    let count = 0
    for (let i = 3; i < data.length; i += 4) if (data[i] > 0) count++
    return count
  })
}

/** Waits until the Stage has mounted its three layer canvases (background, strokes, cursor). */
async function waitForCanvas(page: Page) {
  await expect(page.locator('[data-testid=canvas] canvas')).toHaveCount(3)
}

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
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

  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Export PNG' }).click()
  const download = await downloadPromise
  expect(download.suggestedFilename()).toBe('painting.png')

  const png = await readFile(await download.path())
  // PNG header: width and height are big-endian at bytes 16 and 20 of the IHDR chunk.
  expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([3200, 2000])

  // The background is white and opaque, and the stroke is in the export.
  const [corner, middle] = await page.evaluate(
    async (dataUrl) => {
      const image = new Image()
      image.src = dataUrl
      await image.decode()
      const canvas = document.createElement('canvas')
      canvas.width = image.width
      canvas.height = image.height
      const ctx = canvas.getContext('2d')!
      ctx.drawImage(image, 0, 0)
      return [
        Array.from(ctx.getImageData(2, 2, 1, 1).data),
        Array.from(ctx.getImageData(1600, 1000, 1, 1).data),
      ]
    },
    `data:image/png;base64,${png.toString('base64')}`,
  )
  expect(corner).toEqual([255, 255, 255, 255])
  expect(middle).toEqual([0, 0, 0, 255])

  // Autosave keeps the drawing across a reload.
  await page.reload()
  await waitForCanvas(page)
  await expect(clear).toBeEnabled()
  await expect.poll(() => paintedPixels(page)).toBeGreaterThan(0)
})

test('eraser reveals the white background in the export', async ({ page }) => {
  await drawLine(page, [0.2, 0.5], [0.8, 0.5])
  await page.keyboard.press('e')
  await expect(page.getByRole('button', { name: 'Eraser' })).toHaveAttribute('aria-pressed', 'true')
  await page.keyboard.press(']')
  await page.keyboard.press(']')
  await drawLine(page, [0.5, 0.3], [0.5, 0.7])

  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Export PNG' }).click()
  const png = await readFile(await (await downloadPromise).path())

  const [erased, kept] = await page.evaluate(
    async (dataUrl) => {
      const image = new Image()
      image.src = dataUrl
      await image.decode()
      const canvas = document.createElement('canvas')
      canvas.width = image.width
      canvas.height = image.height
      const ctx = canvas.getContext('2d')!
      ctx.drawImage(image, 0, 0)
      return [
        Array.from(ctx.getImageData(1600, 1000, 1, 1).data),
        Array.from(ctx.getImageData(1000, 1000, 1, 1).data),
      ]
    },
    `data:image/png;base64,${png.toString('base64')}`,
  )
  expect(erased).toEqual([255, 255, 255, 255])
  expect(kept).toEqual([0, 0, 0, 255])

  // Keyboard undo and redo step over the eraser stroke.
  await page.keyboard.press('Control+z')
  await expect(page.getByRole('button', { name: 'Redo' })).toBeEnabled()
  await page.keyboard.press('Control+Shift+z')
  await expect(page.getByRole('button', { name: 'Redo' })).toBeDisabled()
})
