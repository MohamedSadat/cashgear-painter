import type Konva from 'konva'
import { Line, Shape } from 'react-konva'
import { GRID_SIZE } from '../lib/snap/snap'
import { currentPageOf, useEditorStore, zoomOf } from '../store/editorStore'
import { GRID_COLOR, GUIDE_COLOR } from './overlayStyle'

// Grid lines closer than this on screen would be a gray wash; the grid then shows every 2nd,
// 4th... line. Snapping keeps the 8-unit spacing.
const MIN_GRID_GAP_PX = 8

/**
 * The 8-unit grid across the page, as 1-screen-pixel lines over the part of the page on screen.
 * It is on the overlay layer, so the PNG export leaves it out.
 */
function Grid() {
  const page = useEditorStore(currentPageOf)
  const zoom = useEditorStore(zoomOf)
  const view = useEditorStore((s) => s.view)
  const viewport = useEditorStore((s) => s.viewport)
  if (zoom <= 0) return null
  let gap = GRID_SIZE
  while (gap * zoom < MIN_GRID_GAP_PX) gap *= 2
  // The page's part on screen, in canvas units.
  const left = Math.max(0, -view.x / zoom)
  const top = Math.max(0, -view.y / zoom)
  const right = Math.min(page.width, (viewport.width - view.x) / zoom)
  const bottom = Math.min(page.height, (viewport.height - view.y) / zoom)
  if (right <= left || bottom <= top) return null

  const draw = (ctx: Konva.Context, shape: Konva.Shape) => {
    ctx.beginPath()
    for (let x = Math.ceil(left / gap) * gap; x <= right; x += gap) {
      ctx.moveTo(x, top)
      ctx.lineTo(x, bottom)
    }
    for (let y = Math.ceil(top / gap) * gap; y <= bottom; y += gap) {
      ctx.moveTo(left, y)
      ctx.lineTo(right, y)
    }
    ctx.strokeShape(shape)
  }
  return (
    <Shape
      name="snap-grid"
      sceneFunc={draw}
      stroke={GRID_COLOR}
      strokeWidth={1}
      strokeScaleEnabled={false}
      listening={false}
      perfectDrawEnabled={false}
    />
  )
}

/** The smart guides of the snap being dragged, 1 screen pixel wide, and the grid when it shows. */
export function SnapOverlay() {
  const guides = useEditorStore((s) => s.guides)
  const grid = useEditorStore((s) => s.grid)
  return (
    <>
      {grid && <Grid />}
      {guides.map((g) => (
        <Line
          key={`${g.axis}${g.at}`}
          name="snap-guide"
          points={g.axis === 'x' ? [g.at, g.from, g.at, g.to] : [g.from, g.at, g.to, g.at]}
          stroke={GUIDE_COLOR}
          strokeWidth={1}
          strokeScaleEnabled={false}
          listening={false}
        />
      ))}
    </>
  )
}
