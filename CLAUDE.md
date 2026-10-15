# Simple Painter — Implementation Plan

## Goal and scope

Build a browser painter in React that a coding agent delivers in 7 short sessions: smooth pressure-aware strokes, an eraser, undo/redo and PNG export, on desktop and phone.

**In scope (MVP)**

- Freehand brush with smooth strokes from mouse, touch and pen (with pen pressure)
- Eraser
- Color: 8 preset swatches plus a custom color picker
- Brush size 1 to 64 px
- Undo, redo and clear (clear can be undone)
- Export to PNG on a white background
- Keyboard shortcuts
- Autosave in the browser so a refresh keeps the drawing

**Out of scope (v1)**

- Layers panel, shapes, text, fill bucket
- Image import, zoom and pan
- Server save, accounts, collaboration

## Tech stack

Vite, React, TypeScript and Konva carry the app; tell the agent to install the latest stable versions and pin them after scaffolding.

| Concern               | Choice                           | Why                                                      |
| --------------------- | -------------------------------- | -------------------------------------------------------- |
| Build                 | Vite, `react-ts` template        | Fast dev server, almost no config                        |
| UI                    | React + TypeScript (strict mode) | Largest pool of examples for the agent                   |
| Canvas                | `konva` + `react-konva`          | Declarative layers, built-in PNG export, pointer helpers |
| Stroke smoothing      | `perfect-freehand`               | Turns raw points into a smooth, pressure-aware outline   |
| State                 | `zustand`                        | Tiny store, easy to unit test, no provider boilerplate   |
| Styling               | Tailwind CSS                     | Toolbar styles stay in the JSX, no CSS files to manage   |
| Icons                 | `lucide-react`                   | Clean toolbar icons                                      |
| Unit tests            | Vitest                           | Shares the Vite config                                   |
| End-to-end smoke test | Playwright                       | Draws a stroke and checks undo in a real browser         |
| Lint and format       | ESLint + Prettier                | Keeps agent output consistent across sessions            |

## Architecture

Strokes are stored as data, not pixels: every brush or eraser movement becomes a `Stroke` object, and the canvas only renders that array. Undo, autosave and export all fall out of this.

```
pointer  ─┐                             ┌─► Konva render (Stage, layers)
toolbar  ─┼─► store actions ─► strokes ─┼─► autosave (localStorage)
keyboard ─┘                             └─► export (reads the rendered Stage)
```

Pointer, toolbar and keyboard only call store actions; Konva redraws from the store, autosave watches it, and export reads the rendered Stage.

### Data model

```ts
type Tool = 'brush' | 'eraser'
type Point = [x: number, y: number, pressure: number]

interface Stroke {
  id: string
  tool: Tool
  color: string // hex; ignored for eraser
  size: number // in canvas units
  usesPressure: boolean // true only when drawn with a pen
  points: Point[]
}
```

### Store (zustand)

```ts
interface PaintState {
  strokes: Stroke[]
  draft: Stroke | null // the stroke being drawn right now
  past: Stroke[][] // undo stack (snapshots)
  future: Stroke[][] // redo stack
  tool: Tool
  color: string
  size: number
  beginStroke(p: Point, pointerType: string): void
  extendStroke(p: Point): void
  endStroke(): void
  undo(): void
  redo(): void
  clear(): void
  setTool(t: Tool): void
  setColor(c: string): void
  setSize(n: number): void
}
```

- `endStroke` pushes the current `strokes` onto `past`, appends the draft and empties `future`.
- Snapshots are cheap because the arrays share the same stroke objects. Cap `past` at 100 entries.
- `clear` is an ordinary history step, so it can be undone.

### Rendering (Konva layers, bottom to top)

1. **Background layer:** one white `Rect` covering the canvas. Never erased.
2. **Strokes layer:** one memoized `StrokeShape` (a Konva `Path`) per finished stroke, then the draft as the last child. Eraser strokes use `globalCompositeOperation="destination-out"`, which cuts through this layer and reveals the white background.
3. **Cursor layer:** a circle outline under the pointer showing the brush size. `listening={false}`.

Each stroke's outline comes from `getStroke(points, { size, thinning: 0.5, smoothing: 0.5, streamline: 0.5, simulatePressure: !usesPressure, last: true })`, converted to an SVG path string for the Konva `Path`. Cache that string per stroke with `useMemo`.

### Canvas size and coordinates

- The canvas is a fixed 1600 × 1000 logical units. The Stage is scaled to fit its container (ResizeObserver), keeping the aspect ratio.
- Read the pointer with `layer.getRelativePointerPosition()` so points are in canvas units at any scale.
- Result: drawings never shift on resize, and exports are always the same size.

### Input

- Use pointer events on the Stage (`onPointerDown`, `onPointerMove`, `onPointerUp`) plus a `pointerup` listener on `window`, so a stroke ends even when released off the canvas.
- Pressure comes from `evt.pressure` for pens only; mouse and touch get simulated pressure.
- The canvas container gets `touch-action: none` so drawing on a phone doesn't scroll the page.
- Ignore a second finger while a stroke is in progress.

### Export

- Hide the cursor layer, call `stage.toDataURL({ pixelRatio: 2 / scale })` to get a 3200 × 2000 PNG, then download it through an `<a download="painting.png">`.

### Autosave

- Write `strokes` to `localStorage` key `painter:v1`, debounced 500 ms; load it on start. Wrap reads and writes in try/catch.

### Keyboard shortcuts

- Ctrl/Cmd+Z undo · Ctrl/Cmd+Shift+Z or Ctrl+Y redo · B brush · E eraser · [ and ] smaller/larger brush. Skip shortcuts while focus is in an input.

## Folder structure

Keep drawing logic in `lib/` and the store, so most of it can be unit tested without a browser.

```
painter/
├─ index.html
├─ CLAUDE.md / AGENTS.md     # this plan, exported to Markdown
├─ src/
│  ├─ main.tsx
│  ├─ App.tsx                # layout: toolbar + canvas
│  ├─ types.ts               # Tool, Point, Stroke
│  ├─ store/
│  │  ├─ paintStore.ts       # zustand store + history
│  │  └─ paintStore.test.ts
│  ├─ components/
│  │  ├─ CanvasStage.tsx     # Stage, layers, pointer handling
│  │  ├─ StrokeShape.tsx     # memoized Path per stroke
│  │  ├─ BrushCursor.tsx
│  │  └─ Toolbar.tsx         # tools, colors, size, undo/redo, export
│  ├─ lib/
│  │  ├─ strokePath.ts       # points → SVG path via perfect-freehand
│  │  ├─ strokePath.test.ts
│  │  ├─ exportPng.ts
│  │  └─ persistence.ts      # localStorage load/save
│  └─ hooks/
│     ├─ useFitScale.ts      # ResizeObserver → stage scale
│     └─ useShortcuts.ts
└─ e2e/
   └─ draw.spec.ts
```

## Milestones

Seven milestones, one per agent session; each ends only when its check passes and `lint`, `test` and `build` are green.

1. **M0 · Scaffold.** Vite `react-ts`, all dependencies, Tailwind, ESLint/Prettier, Vitest, Playwright. Scripts: `dev`, `build`, `lint`, `test`, `e2e`.
   - Done when: every script passes on the empty app.
2. **M1 · Draw.** `types.ts`, store (begin/extend/end only), `strokePath.ts`, `CanvasStage` with the fixed 1600 × 1000 canvas scaled to fit, background and strokes layers.
   - Done when: smooth black strokes work with mouse and touch, the page doesn't scroll on touch, and strokes stay in place when the window resizes.
3. **M2 · Toolbar.** Brush/eraser toggle, 8 swatches plus custom color, size slider 1 to 64, brush cursor circle.
   - Done when: the eraser reveals white (not transparent) and the cursor circle matches the brush size at any window size.
4. **M3 · History.** Undo, redo, clear; buttons disabled when there is nothing to undo or redo; keyboard shortcuts.
   - Done when: store tests cover undo after clear, redo stack emptied by a new stroke, and the 100-step cap.
5. **M4 · Export.** Download `painting.png` at 3200 × 2000 with a white background and no cursor.
   - Done when: the file opens in an image viewer and matches the screen.
6. **M5 · Autosave and mobile.** Debounced localStorage, toolbar that fits a 375 px wide screen, pen pressure.
   - Done when: a refresh restores the drawing, and it works in Chrome on Android and Safari on iOS.
7. **M6 · Tests and release build.** Playwright smoke test: draw, undo, redo, export triggers a download. `npm run build` produces static files.
   - Done when: all scripts pass from a clean clone.

## Gotchas

Most painter bugs come from layers, coordinates and pressure; spell these out to the agent up front.

- **Eraser in its own layer erases nothing.** `destination-out` only cuts the layer it is drawn in, so the live eraser draft must sit inside the strokes layer.
- **Background inside the strokes layer gets holes.** Keep the white `Rect` in its own layer, or erasing exports as transparent.
- **Scaled stage, wrong coordinates.** Raw `getPointerPosition()` returns screen pixels; strokes land offset unless you use the relative position.
- **Flat-looking mouse strokes.** Mice report a constant pressure; without `simulatePressure` every stroke has the same width.
- **Lag with many strokes.** Memoize `StrokeShape`, cache path strings, set `listening={false}`. If it still lags, flattening old strokes to an image is the next step (not in v1).
- **localStorage limit (about 5 MB).** Round coordinates to 1 decimal and catch quota errors.
- **StrictMode double effects.** ResizeObserver and window listeners need cleanup functions.
- **iOS long-press menu.** Add `user-select: none` and `-webkit-touch-callout: none` to the canvas container.

## Driving the coding agent

Export this doc to Markdown, save it in the repo root (`CLAUDE.md` for Claude Code, `AGENTS.md` for Codex), and run one milestone per session.

Prompt for each session:

```
Read CLAUDE.md. Implement milestone M1 only.
Follow the data model and folder structure exactly; don't add libraries.
When done, run: npm run lint && npm run test && npm run build
Fix every error, then list what changed and anything you skipped.
```

- Between sessions: run `npm run dev -- --host`, try it on your phone, then commit.
- If the agent drifts (new libraries, a different data model), point it back to the relevant section here.

## Definition of done

- [ ] Every in-scope feature works in Chrome, Edge and Firefox on desktop, and Chrome on Android and Safari on iOS
- [ ] `lint`, unit tests and the Playwright smoke test pass
- [ ] Undo and redo stay correct after clear and after eraser strokes
- [ ] Exported PNG is 3200 × 2000 with a white background
- [ ] A page refresh keeps the drawing
- [ ] `npm run build` output runs from any static host

## Repo notes

- This repo root is the `painter/` folder above.
- The current Vite `react-ts` template ships oxlint; it was replaced with ESLint (flat config) + Prettier to match the stack table.
- `src/lib/persistence.test.ts` is an extra unit test beyond the folder structure above.
- Stroke ids don't use `crypto.randomUUID()`: it is missing on plain-http LAN URLs such as `npm run dev -- --host`.
