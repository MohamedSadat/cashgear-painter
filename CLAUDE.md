# Simple Painter — Vector Extension Plan

## Goal and scope

Turn Simple Painter into a vector editor in 8 more agent sessions (M7 to M14). Every mark becomes a selectable, editable object, and drawings export as SVG as well as PNG. The stack stays React, TypeScript, Konva and zustand, plus 4 small libraries.

**In scope (v2)**

- Select, move, resize, rotate, duplicate and delete any object
- Shape tools: rectangle, ellipse, line and arrow
- Pen tool with Bézier curves, and node editing on existing paths
- Text objects
- Per-object fill, stroke, stroke width, opacity and corner radius
- Groups, z-order and a layers panel (hide, lock, rename, reorder)
- Zoom and pan with wheel, pinch and Space-drag
- Object eraser first, then a partial eraser that splits freehand strokes
- SVG export, basic SVG import, and save/open as a `.painter.json` file
- Existing v1 drawings open and stay editable

**Out of scope (v2)**

- Boolean operations (union, subtract), gradients and patterns
- Image import and raster editing
- Multiple artboards, smart guides and snapping to other objects
- Server save, accounts, collaboration

## Starting point

v1 already stores strokes as data, not pixels, so this is a model change, not a rewrite. The pointer pipeline, `strokePath.ts`, `useFitScale`, the test setup and the agent workflow carry over.

| Area         | v1 today                         | v2                                                                  |
| ------------ | -------------------------------- | ------------------------------------------------------------------- |
| Data         | `Stroke[]`                       | `Doc`: a node map plus z-order lists; strokes become `stroke` nodes |
| Eraser       | `destination-out` pixel cut      | Object eraser, later a stroke-splitting eraser                      |
| History      | Snapshots of `strokes`           | Snapshots of `doc` via immer, one step per gesture                  |
| Canvas       | Fixed 1600 × 1000, fit to window | Same artboard, plus zoom and pan                                    |
| Konva layers | Background, strokes, cursor      | Background, content, overlay                                        |
| Toolbar      | Brush, eraser, color, size       | Tool rail, properties panel, layers panel                           |
| Export       | PNG 3200 × 2000                  | Same PNG, plus SVG and `.painter.json`                              |
| Autosave     | localStorage `painter:v1`        | IndexedDB `painter:v2`, migrates v1 once                            |

The eraser is the one breaking change. `destination-out` can't be expressed as editable objects or plain SVG, so v1 eraser strokes are converted on migration (see History, persistence and files).

**New libraries** (install latest stable, then pin)

- `immer`: immutable updates for the `doc`
- `idb-keyval`: tiny IndexedDB wrapper for autosave
- `bezier-js`: curve bounds, nearest point and hit tests for paths
- `svgpath`: normalizes imported SVG path data to absolute cubic curves

## Architecture

v2 keeps v1's rule that the document is data and the canvas only renders it. It adds a tool layer between input and store, so each tool's logic lives in one file.

```
pointer  ─┐                                       ┌─► content layer (renders the doc) ─► PNG export
keyboard ─┴─► active tool ─┐                      ├─► exporters (SVG, .painter.json)
                           ├─► editor store ──────┼─► overlay layer (selection, handles)
panels ── direct actions ──┘   doc, selection,    └─► autosave (IndexedDB)
                               view, history
```

Pointer and keyboard input go to the active tool, which calls store actions; panels call actions directly. Konva layers, autosave and exporters only read the store, except PNG, which reads the rendered content layer.

### Folder changes

`BrushCursor.tsx` moves into the overlay layer, and `Toolbar.tsx` splits into a tool rail and two panels.

```
src/
├─ types.ts                 # v2 model (replaces the Stroke-only types)
├─ store/
│  ├─ editorStore.ts        # replaces paintStore.ts: doc, selection, history, view
│  ├─ editorStore.test.ts
│  └─ migrate.ts            # painter:v1 → v2, with tests
├─ tools/
│  ├─ types.ts              # ToolController, ToolEvent
│  ├─ selectTool.ts
│  ├─ directTool.ts
│  ├─ brushTool.ts
│  ├─ eraserTool.ts
│  ├─ shapeTools.ts         # rect, ellipse, line
│  ├─ penTool.ts
│  ├─ textTool.ts
│  └─ handTool.ts
├─ components/
│  ├─ CanvasStage.tsx       # Stage + layers; routes pointer events to the tool
│  ├─ NodeView.tsx          # one memoized Konva shape per node
│  ├─ SelectionOverlay.tsx  # Transformer, marquee
│  ├─ PathEditOverlay.tsx   # anchors and handles
│  ├─ TextEditor.tsx        # textarea overlay
│  ├─ ToolRail.tsx
│  ├─ PropertiesPanel.tsx
│  └─ LayersPanel.tsx
├─ lib/
│  ├─ strokePath.ts         # unchanged
│  ├─ geometry/             # pathData, bounds, hitTest, eraseSplit (+ tests)
│  ├─ svg/                  # exportSvg, importSvg (+ tests)
│  ├─ exportPng.ts          # crops to the artboard at any zoom
│  └─ persistence.ts        # IndexedDB autosave, .painter.json save/open
└─ hooks/
   ├─ useFitScale.ts        # unchanged
   ├─ useViewport.ts        # wheel, pinch, Space-drag
   └─ useShortcuts.ts
```

## Data model v2

Every object is a node in a flat map, and order lives in id lists. Moving, restyling, grouping and reordering then touch only the nodes involved.

```ts
type NodeId = string // newNodeId(), see Repo notes
type Point = [x: number, y: number, pressure: number] // unchanged from v1

interface Transform {
  x: number
  y: number
  rotation: number
  scaleX: number
  scaleY: number
}

interface Style {
  fill: string | null // hex; null = no fill
  stroke: string | null
  strokeWidth: number // canvas units, never scaled by transforms
  opacity: number // 0..1
}

interface BaseNode {
  id: NodeId
  name: string
  parentId: NodeId | null // null = top level
  transform: Transform
  style: Style
  hidden: boolean
  locked: boolean
}

interface Anchor {
  x: number // local coordinates
  y: number
  inX: number // handle toward the previous anchor, relative to x/y
  inY: number
  outX: number // handle toward the next anchor, relative to x/y
  outY: number
  kind: 'corner' | 'smooth' | 'symmetric'
}

type VectorNode =
  | (BaseNode & { type: 'stroke'; points: Point[]; size: number; usesPressure: boolean })
  | (BaseNode & { type: 'rect'; width: number; height: number; cornerRadius: number })
  | (BaseNode & { type: 'ellipse'; rx: number; ry: number })
  | (BaseNode & {
      type: 'line'
      points: [number, number, number, number]
      arrowStart: boolean
      arrowEnd: boolean
    })
  | (BaseNode & { type: 'path'; anchors: Anchor[]; closed: boolean })
  | (BaseNode & {
      type: 'text'
      text: string
      fontFamily: string
      fontSize: number
      fontStyle: 'normal' | 'bold' | 'italic' | 'bold italic'
      align: 'left' | 'center' | 'right'
      width: number
    })
  | (BaseNode & { type: 'group'; childIds: NodeId[] })

interface Doc {
  version: 2
  width: 1600 // the artboard, as in v1
  height: 1000
  background: string // '#ffffff'
  nodes: Record<NodeId, VectorNode>
  rootIds: NodeId[] // z-order, bottom to top; groups order their own childIds
}
```

- Geometry is in local coordinates and `transform` places it. Migrated v1 strokes keep their absolute points with an identity transform.
- A `stroke` node renders as a filled outline: `style.fill` holds the brush color and `style.stroke` is null.
- `size` on a stroke stays the brush size, so a migrated stroke looks exactly as before.

### Store (zustand + immer)

```ts
type ToolId =
  'select' | 'direct' | 'brush' | 'eraser' | 'rect' | 'ellipse' | 'line' | 'pen' | 'text' | 'hand'

interface EditorState {
  doc: Doc
  selection: NodeId[]
  past: Doc[]
  future: Doc[] // undo/redo, capped at 100
  gestureStart: Doc | null // doc when the current drag began
  tool: ToolId
  brush: { color: string; size: number }
  view: { scale: number; x: number; y: number } // zoom and pan, not in history

  addNodes(nodes: VectorNode[], parentId?: NodeId): void
  updateNodes(patch: Record<NodeId, Partial<VectorNode>>): void
  deleteNodes(ids: NodeId[]): void
  reorder(ids: NodeId[], where: 'forward' | 'backward' | 'front' | 'back'): void
  group(ids: NodeId[]): void
  ungroup(id: NodeId): void
  beginGesture(): void
  endGesture(): void
  undo(): void
  redo(): void
  clear(): void
  select(ids: NodeId[], mode?: 'replace' | 'add' | 'toggle'): void
  setTool(t: ToolId): void
}
```

- Each document action is one history step, unless a gesture is open.
- `beginGesture` saves the current doc. Updates during the drag skip `past`, and `endGesture` pushes the saved doc once, so a drag is one undo step.
- immer keeps untouched nodes as the same objects. Snapshots stay cheap and memoized shapes don't re-render.
- Selection, tool and view are UI state: not in history, not autosaved. After undo or redo, drop selected ids that no longer exist.

## Rendering, hit testing and zoom

Konva keeps doing the drawing and the clicking; the change is three layers with clear jobs and one memoized component per node.

**Konva layers, bottom to top**

1. **Background layer:** a gray pasteboard and the white 1600 × 1000 artboard `Rect`. `listening={false}`.
2. **Content layer:** one `NodeView` per node, memoized on the node object. Groups render a Konva `Group` with their children. Hidden nodes are skipped, and locked nodes get `listening={false}`.
3. **Overlay layer:** the selection `Transformer`, marquee, pen preview, anchors and handles, and the brush cursor. Sizes are divided by `view.scale` so they stay constant on screen.

**Node to Konva shape**

| Node      | Konva shape | Notes                                                |
| --------- | ----------- | ---------------------------------------------------- |
| `stroke`  | `Path`      | perfect-freehand outline, filled, cached per node    |
| `rect`    | `Rect`      | `cornerRadius`                                       |
| `ellipse` | `Ellipse`   |                                                      |
| `line`    | `Arrow`     | pointers off unless `arrowStart` / `arrowEnd`        |
| `path`    | `Path`      | `d` built from anchors by `lib/geometry/pathData.ts` |
| `text`    | `Text`      | `wrap="word"`, fixed `width`                         |
| `group`   | `Group`     | applies its transform to children                    |

Cache path strings in a `WeakMap` keyed by node object, so an unchanged node never recomputes its outline.

**Zoom and pan**

- `view.scale` multiplies v1's fit scale; `view.x` and `view.y` are the Stage position.
- Ctrl/Cmd + wheel (and trackpad pinch, which arrives as Ctrl + wheel) zooms around the pointer, from 0.1× to 32×. Plain wheel pans.
- Two fingers on touch pinch-zoom and pan. Space-drag or the hand tool pans.
- Keep reading points with `layer.getRelativePointerPosition()` on the content layer; it already undoes zoom and pan.

**Hit testing and selection**

- Konva's hit canvas handles clicks. Give strokes, lines and paths a `hitStrokeWidth` of 12 screen px (12 / `view.scale`) so thin lines are easy to grab.
- An unfilled shape is hit only on its outline, so clicking inside an empty rectangle selects what is underneath.
- Clicking a group's child selects the group; double-click enters the group and selects the child.
- Marquee select uses model bounds from `lib/geometry/bounds.ts`: an object is selected when its box is fully inside. Path bounds come from `bezier-js` curve extrema, not the anchor positions.

**Transforms**

- On `transformend`, bake the Konva scale into geometry and reset scale to 1: width and height for rects, radii for ellipses, points for lines, anchors and handles for paths.
- Text: side handles change `width`; corner handles scale `fontSize`.
- Freehand strokes keep scale in their `transform`, because their outline is a fill and scales correctly.
- Rotation is stored in degrees; Shift snaps it to 15°.

## Tools

Each tool is a small controller in `src/tools/`, and `CanvasStage` only routes pointer events to the active one. Adding a tool never touches the canvas component.

```ts
interface ToolEvent {
  point: [number, number]
  pressure: number
  pointerType: string
  shift: boolean
  alt: boolean
  mod: boolean
  target: NodeId | null
}

interface ToolController {
  cursor: string
  onDown(e: ToolEvent): void
  onMove(e: ToolEvent): void
  onUp(e: ToolEvent): void
  onKey?(e: KeyboardEvent): boolean // true = handled
  onCancel?(): void // Esc or tool switch
}
```

| Tool          | Key                       | Behavior                                                                                                                              |
| ------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Select        | V                         | Click selects, Shift-click adds. Drag on empty canvas draws a marquee. Drag moves; handles resize and rotate (Shift keeps the ratio). |
| Direct select | A, or double-click a path | Drag anchors and handles. Alt-drag a handle breaks symmetry. Double-click a segment adds an anchor; Delete removes it.                |
| Brush         | B                         | As in v1; each stroke becomes a `stroke` node.                                                                                        |
| Eraser        | E                         | Deletes every unlocked object the eraser circle touches, in one step at pointer-up. Touched objects dim while erasing.                |
| Rectangle     | R                         | Drag to draw. Shift makes a square, Alt draws from the center.                                                                        |
| Ellipse       | O                         | Same modifiers as the rectangle.                                                                                                      |
| Line / arrow  | L                         | Drag to draw; Shift snaps to 45°. Arrowheads are set in the properties panel.                                                         |
| Pen           | P                         | Click adds a corner anchor, click-drag a smooth one. Click the first anchor to close; Enter or Esc ends an open path.                 |
| Text          | T                         | Click to place, drag to set a width. Typing happens in a textarea overlay.                                                            |
| Hand          | H, or hold Space          | Drag to pan.                                                                                                                          |

**Other shortcuts:** Delete or Backspace deletes. Ctrl/Cmd + D duplicates, + G groups, + Shift + G ungroups. Ctrl/Cmd + ] and [ move forward and backward (add Shift for front and back). Arrow keys nudge 1 unit, Shift + arrow 10. Ctrl/Cmd + A selects all, + 0 fits the artboard, + 1 sets 100%. Plain [ and ] still resize the brush, as in v1.

**Pen tool and paths**

- `pathData` writes `M` at the first anchor, then `C prev.out, cur.in, cur` per segment, plus a closing segment when `closed`. Handles are stored relative to their anchor.
- A `smooth` anchor keeps both handles in line; `symmetric` also keeps them equal in length. Dragging one handle updates its twin by those rules.
- "Convert to path" turns a rect, ellipse or line into a `path` node so it can be node-edited. An ellipse becomes 4 anchors with handle length 0.5523 × radius.

**Text editing:** on create or double-click, hide the Konva `Text` and place a textarea over it, positioned from `getAbsolutePosition()` and the stage scale. Commit on blur or Ctrl/Cmd + Enter, cancel on Esc, and delete the node if the text is empty.

**Panels**

- Properties panel (right side on desktop, bottom sheet under 640 px): fill, stroke, width, opacity, corner radius, arrowheads, font. Mixed values show "Mixed"; a change applies to every selected object as one step.
- Layers panel: the node tree with the front-most object on top. Drag to reorder, eye to hide, lock icon, double-click to rename.

## History, persistence and files

The `Doc` is the single source for undo, autosave, SVG and the native file; only PNG reads the rendered Stage.

**History**

- Snapshot history as in v1, now of `doc`, capped at 100 and grouped by gesture (Data model v2).
- Arrow-key nudges within 500 ms of each other merge into one step.
- `clear` stays an ordinary, undoable step.

**Autosave and migration**

- Autosave `doc` to IndexedDB with `idb-keyval`, key `painter:v2`, debounced 500 ms. Vector docs outgrow localStorage's ~5 MB.
- On start, if `painter:v2` is missing and `painter:v1` exists, migrate once and leave the v1 key as a backup.
- Brush strokes become `stroke` nodes with `fill` = their color and an identity transform.
- Eraser strokes are applied in order with `lib/geometry/eraseSplit.ts`: points of earlier strokes inside the eraser path are removed, splitting each stroke into separate runs. Runs under 2 points are dropped.
- The cut follows stroke points, not the exact outline, so erased edges may shift slightly. The same function powers the partial eraser in M14.

**Save and open**

- Save downloads `drawing.painter.json` (the `Doc`); Open reads one through `<input type="file">` and rejects unknown `version` values.

**PNG export (unchanged output)**

- Hide the overlay layer, set the Stage to scale 1 and position 0, call `stage.toDataURL({ x: 0, y: 0, width: 1600, height: 1000, pixelRatio: 2 })`, then restore the view. The result is 3200 × 2000 at any zoom.

**SVG export** (`lib/svg/exportSvg.ts`)

- Serialize the model, not Konva: `<svg viewBox="0 0 1600 1000" width="1600" height="1000">` plus a background `<rect>`.
- Each node gets `transform="translate(x y) rotate(r) scale(sx sy)"`; groups become `<g>`; hidden nodes are skipped.
- `stroke` → filled `<path>`, `rect` → `<rect rx>`, `ellipse` → `<ellipse>`, `line` → `<line>` with `<marker>` arrowheads, `path` → `<path d>`, `text` → `<text>` with one `<tspan>` per line.
- Fonts are not embedded, so the text tool offers only web-safe fonts in v2.

**SVG import** (`lib/svg/importSvg.ts`)

- Parse with `DOMParser`. Supported: `g`, `rect`, `circle`, `ellipse`, `line`, `polyline`, `polygon`, `path`, plus `fill`, `stroke`, `stroke-width`, `opacity` and inline `style`.
- `svgpath` turns path data into absolute cubic curves and applies element `transform`s, so imported shapes become `path` nodes. Quadratic curves are raised to cubic.
- Text, gradients, CSS classes, masks and images are skipped, and a toast reports how many elements were skipped.
- Imported content lands as one group, scaled down to fit the artboard when larger.

## Milestones

Eight milestones continue v1's numbering, one per agent session. Each ends only when its check passes and `lint`, `test` and `build` are green.

1. **M7 · Model v2 and migration.** v2 `types.ts`, `editorStore.ts` on `doc` + immer with gesture history, `NodeView` for `stroke` nodes, `eraseSplit.ts`, v1 migration, IndexedDB autosave. The eraser deletes touched strokes for now.
   - Done when: a saved v1 drawing opens looking the same apart from eraser edges, and store tests cover migration, gestures and the 100-step cap.
2. **M8 · Zoom, pan and overlay.** `view` state, wheel, pinch and Space-drag, Ctrl/Cmd + 0 and + 1, overlay layer, PNG export cropped to the artboard.
   - Done when: strokes land under the pointer at 0.1× and 32×, and the PNG is identical at any zoom.
3. **M9 · Selection and transform.** Select tool, marquee, `Transformer` with scale baking, move, resize, rotate, delete, duplicate, nudge, z-order, copy and paste.
   - Done when: each transform is one undo step, and a rotated, resized stroke survives a refresh.
4. **M10 · Shapes and properties.** Rectangle, ellipse and line/arrow tools; properties panel with mixed values; a tool rail replaces the v1 toolbar.
   - Done when: each shape can be drawn, restyled and undone on a 375 px wide phone screen.
5. **M11 · Pen and node editing.** `path` nodes, `pathData.ts`, pen tool, direct-select tool, add and remove anchors, convert to path, `bezier-js` bounds and hit tests.
   - Done when: a closed 4-anchor heart can be reshaped by its handles, and `pathData` unit tests pass.
6. **M12 · Text, groups and layers.** Text tool with the textarea overlay, group and ungroup with enter-group, layers panel with reorder, hide, lock and rename.
   - Done when: a text edit undoes as one step, and hidden or locked objects can't be picked on the canvas.
7. **M13 · SVG and files.** SVG export, SVG import subset, `.painter.json` save and open.
   - Done when: the exported SVG matches the screen in Chrome and Inkscape, and a unit test round-trips shapes, paths and strokes through export and import.
8. **M14 · Partial eraser and release.** Eraser mode toggle (object or split) using `eraseSplit.ts`; Playwright suite: draw a shape, transform it, draw a pen path, undo, download SVG.
   - Done when: all scripts pass from a clean clone.

### Definition of done

- [ ] Every object type can be created, selected, transformed, restyled, reordered and deleted, with undo
- [ ] v1 drawings open and stay editable
- [ ] Exported SVG opens in Chrome, Firefox and Inkscape and matches the screen
- [ ] PNG export is still 3200 × 2000 with a white background
- [ ] Mouse, touch and pen work in Chrome, Edge and Firefox on desktop, Chrome on Android and Safari on iOS
- [ ] `lint`, unit tests and the Playwright suite pass

## Gotchas and open decisions

Most vector-editor bugs come from transforms, history granularity and coordinate spaces; give these to the agent up front.

**Gotchas**

- **Resized shapes get thick outlines.** Konva scales the stroke with the shape. Bake scale into geometry on `transformend` and reset it to 1.
- **One drag, a hundred undo steps.** Wrap drags, resizes, pen drawing and eraser passes in `beginGesture` / `endGesture`.
- **Handles grow and shrink with zoom.** Keep overlay handles, cursor and `hitStrokeWidth` a constant screen size by dividing by `view.scale` wherever Konva doesn't already.
- **Group children in the wrong place.** A child's screen position is the group transform times its own. Use `getAbsoluteTransform()` for overlays, and nest `<g>` the same way in SVG.
- **Text editor drifts from its text.** Reposition the textarea on zoom, pan and resize, or commit and close it when the view changes.
- **Stale selection after undo.** Drop selected ids missing from the restored `doc`.
- **Pinch starts a stroke.** If a second finger lands before the first has moved 8 px, cancel the draft and treat it as a pinch.
- **Shortcuts typed into text.** Skip canvas shortcuts while the textarea or any input has focus, as in v1.

**v1 gotchas (still apply)**

- **Scaled stage, wrong coordinates.** Raw `getPointerPosition()` returns screen pixels; strokes land offset unless you use the relative position.
- **Flat-looking mouse strokes.** Mice report a constant pressure; without `simulatePressure` every stroke has the same width.
- **Lag with many strokes.** Memoize `NodeView`, cache path strings, set `listening={false}` where nothing needs clicks. If it still lags, flattening old strokes to an image is the next step (not in v2).
- **Storage size.** Round coordinates to 1 decimal and catch quota and write errors.
- **StrictMode double effects.** ResizeObserver and window listeners need cleanup functions.
- **iOS long-press menu.** Add `user-select: none` and `-webkit-touch-callout: none` to the canvas container.

v1's two `destination-out` gotchas no longer apply: v2 erases objects, not pixels.

**Open decisions**

| Decision           | Plan's pick                                                                | Alternative                                                     |
| ------------------ | -------------------------------------------------------------------------- | --------------------------------------------------------------- |
| v1 eraser strokes  | Split strokes on migration (slightly approximate edges)                    | Keep them as SVG masks: exact, but complex to edit and export   |
| Canvas             | Fixed 1600 × 1000 artboard; objects outside are kept but clipped on export | Infinite canvas with export to the content bounds               |
| Text in SVG        | Live text with web-safe fonts                                              | Convert text to outlines with a font parser such as opentype.js |
| Boolean operations | Not in v2                                                                  | Paper.js run headless for union and subtract on paths           |

## Driving the coding agent

Run one milestone per session. Prompt for each session:

```
Read CLAUDE.md. Implement milestone M8 only.
Follow the data model and folder structure exactly; don't add libraries.
When done, run: npm run lint && npm run test && npm run build
Fix every error, then list what changed and anything you skipped.
```

- Between sessions: run `npm run dev -- --host`, try it on your phone, then commit.
- If the agent drifts (new libraries, a different data model), point it back to the relevant section here.

## Repo notes

- The folder tree above is relative to this repo root.
- The current Vite `react-ts` template ships oxlint; it was replaced with ESLint (flat config) + Prettier to match the stack table.
- `src/lib/persistence.test.ts` and `src/tools/tools.test.ts` are extra unit tests beyond the folder structure above.
- Node ids don't use `crypto.randomUUID()`: it is missing on plain-http LAN URLs such as `npm run dev -- --host`. Use `newNodeId()` from `store/editorStore.ts`.
- `editorStore.ts` doesn't use zustand's immer middleware. Doc edits go through a `commit` helper that runs immer's `produce`, so it can compare the doc before and after and skip no-op edits in history.
- The store also holds two pieces of UI state that are neither in history nor autosaved: `draft` (the stroke being drawn, committed by one `addNodes` on pointer-up) and `erasing` (ids the eraser has touched, rendered dimmed).
- `src/tools/index.ts` maps each `ToolId` to its controller, so `CanvasStage` never names a tool.
- Autosave uses IndexedDB database `painter`, object store `kv` (idb-keyval `createStore`), key `painter:v2`.
- Migration erases a brush point when it is within eraser radius + brush radius of the eraser path, so a crossing leaves a gap as wide as the v1 eraser even on thick strokes.
