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

- [x] Every object type can be created, selected, transformed, restyled, reordered and deleted, with undo
- [x] v1 drawings open and stay editable
- [ ] Exported SVG opens in Chrome, Firefox and Inkscape and matches the screen
- [x] PNG export is still 3200 × 2000 with a white background
- [ ] Mouse, touch and pen work in Chrome, Edge and Firefox on desktop, Chrome on Android and Safari on iOS
- [x] `lint`, unit tests and the Playwright suite pass

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

# Simple Painter — v3 Pro Features Plan

## Goal and scope

v3 adds the six features that close most of the visible gap to Canva's editor: pages, snapping and alignment, gradients, boolean operations, images and PDF export. It runs in 7 agent sessions (M15 to M21) on the same React, TypeScript, Konva and zustand stack.

This plan builds on the vector extension plan above and assumes M7 to M14 are done.

**In scope (v3)**

- Multiple pages, each with its own size; presets for print, social and slides
- Snapping to page edges, page center and other objects, with smart guides
- Align and distribute, plus numeric X, Y, W, H and rotation fields
- Linear and radial gradient fills, edited on the canvas
- Boolean operations: union, subtract, intersect, exclude
- Image import by file picker, drag-and-drop and paste, with crop
- Vector PDF export of all pages or a range
- A `.painter` file that carries images

**Out of scope (v3)**

- Live (non-destructive) boolean groups and clipping masks
- Gradient strokes, mesh gradients, blend modes, shadows and blur
- Several artboards side by side on one canvas; Canva-style scrolling through all pages
- CMYK, spot colors, bleed and PDF/X
- Image editing beyond crop (filters, background removal)
- Templates and stock content libraries

## Model changes

v3 changes four things in the model: a document holds pages, paths hold several contours, fills become paints, and images are a new node type. Everything else from v2 stays as it is.

Each page lists its own top-level node ids, while the nodes of every page live in one map. Image nodes point into the asset store by hash.

```ts
type AssetId = string // SHA-256 hex of the image bytes

interface Stop {
  offset: number // 0..1
  color: string
  opacity: number
}

type Paint =
  | { kind: 'solid'; color: string }
  | { kind: 'linear'; stops: Stop[]; start: [number, number]; end: [number, number] } // box units 0..1
  | { kind: 'radial'; stops: Stop[]; center: [number, number]; radius: number } // radius in units of the longer box side

interface Style {
  fill: Paint | null // was string | null
  stroke: string | null // stays solid in v3
  strokeWidth: number
  opacity: number
}

interface Contour {
  anchors: Anchor[]
  closed: boolean
}

// changed and new node types
type PathNode = BaseNode & { type: 'path'; contours: Contour[]; fillRule: 'nonzero' | 'evenodd' }
type ImageNode = BaseNode & {
  type: 'image'
  assetId: AssetId
  width: number
  height: number
  crop: { x: number; y: number; width: number; height: number } | null
}

interface Page {
  id: string
  name: string
  width: number
  height: number // px at 96 dpi
  background: Paint
  rootIds: NodeId[] // z-order, bottom to top
}

interface AssetMeta {
  id: AssetId
  mime: 'image/png' | 'image/jpeg' | 'image/webp'
  width: number
  height: number
  bytes: number
}

interface Doc {
  version: 3
  pages: Page[]
  nodes: Record<NodeId, VectorNode> // every node of every page
  assets: Record<AssetId, AssetMeta> // blobs live in IndexedDB, not here
}
```

**Store additions:** `currentPageId`, a per-page `views` map for zoom and pan, and the actions `addPage`, `duplicatePage`, `deletePage`, `movePage`, `resizePage`, `moveToPage`, `align`, `distribute`, `setFill`, `booleanOp` and `importImages`. Keep a derived `pageOf` map (node id to page id), rebuilt on load and on structural changes.

**Migration v2 → v3** (`store/migrate.ts`)

- The v2 artboard becomes "Page 1" with the same size, a solid background and the v2 `rootIds`.
- Every `fill` string becomes `{ kind: 'solid', color }`.
- Every path's `anchors` and `closed` become one contour, with `fillRule: 'nonzero'`.
- `assets` starts empty. Autosave moves to `painter:v3`; `painter:v2` stays as a backup, and v2 `.painter.json` files migrate on open.

## Pages and page sizes

A page replaces v2's single artboard: each page has its own size, background and object list, and the canvas shows one page at a time.

**Units:** the document unit stays the CSS pixel at 96 dpi. Print sizes are shown in mm in the UI and converted on input (1 mm = 3.7795 px).

| Preset       | Size (px)           | Note                            |
| ------------ | ------------------- | ------------------------------- |
| A4 portrait  | 794 × 1123          | 210 × 297 mm                    |
| US Letter    | 816 × 1056          | 8.5 × 11 in                     |
| Square post  | 1080 × 1080         | Instagram, Facebook             |
| Story        | 1080 × 1920         | Instagram, TikTok               |
| Presentation | 1920 × 1080         | 16:9 slide                      |
| Painter v2   | 1600 × 1000         | Migrated documents              |
| Custom       | 16 to 8000 per side | Width, height, orientation swap |

**Pages panel**

- A vertical strip of thumbnails with add, duplicate, delete, rename and drag-to-reorder. Each change is one undo step.
- Thumbnails come from an offscreen Konva render at 0.1 scale, refreshed when a page is left and 1 s after its last edit.
- PageUp and PageDown switch pages. Each page remembers its own zoom and pan.
- Right-click an object → "Move to page" or "Copy to page".

**Resizing a page** keeps objects where they are, anchored to the top-left. A "Scale content" checkbox scales everything proportionally instead.

**Export per page:** PNG and SVG export the current page at its own size (PNG at 2×). PDF exports all pages or a range (PDF export).

## Snapping, align and distribute

A pure snap engine in `lib/snap/` decides every snapped position; tools call it, and the overlay draws its guides. Keeping it pure makes it fully unit-testable.

```ts
interface Box {
  left: number
  centerX: number
  right: number
  top: number
  centerY: number
  bottom: number
}

interface SnapResult {
  dx: number
  dy: number // correction to apply to the moving box
  guides: { axis: 'x' | 'y'; at: number; from: number; to: number }[]
}

function snapMove(moving: Box, targets: SnapTargets, threshold: number): SnapResult
function snapResize(
  moving: Box,
  edges: ('left' | 'right' | 'top' | 'bottom')[],
  targets: SnapTargets,
  threshold: number,
): SnapResult
```

**How snapping works**

- At drag start, collect target lines: left, center and right x, and top, center and bottom y, of every visible, unselected object on the page, plus the page edges and center. Cache them for the whole drag.
- On each move, find the nearest target per axis within 6 screen px (6 / `view.scale`). Snap each axis independently.
- Guides span from the moving box to the farthest object sharing that line, drawn as thin magenta lines in the overlay.
- Rotated objects snap by their axis-aligned bounding box.
- Moves snap in the select tool's drag handler; resizes snap through the Konva `Transformer`'s `boundBoxFunc`. New shapes snap their drag corner too.
- Hold Ctrl (Cmd on Mac) to drag without snapping; Alt keeps its v2 meanings. A View menu toggle turns snapping off, and an optional 8 px grid adds grid lines as targets.

**Align and distribute**

| Command                   | Shortcut        | Works on                                              |
| ------------------------- | --------------- | ----------------------------------------------------- |
| Align left, center, right | Alt + A, H, D   | 2+ objects to the selection box; 1 object to the page |
| Align top, middle, bottom | Alt + W, V, S   | Same                                                  |
| Distribute horizontally   | Alt + Shift + H | 3+ objects: equal gaps between them                   |
| Distribute vertically     | Alt + Shift + V | 3+ objects: equal gaps between them                   |

Each command is one undo step. Locked objects stay put and act as the reference when selected.

**Numeric transform:** X, Y, W, H and rotation fields at the top of the properties panel. Values update live while dragging, Enter applies, and a lock icon keeps the aspect ratio. Typing math like `200/3` is evaluated.

## Gradients

Fills become a `Paint` instead of a color string. Gradient points are stored in bounding-box units (0 to 1), so a gradient follows its object through moves and resizes.

**Konva rendering** (`lib/paint/toKonva.ts`)

- Convert box units to local pixels using the node's local bounding box, then set the Konva attributes:
  - Solid: `fill`, `fillPriority: 'color'`
  - Linear: `fillLinearGradientStartPoint`, `fillLinearGradientEndPoint`, `fillLinearGradientColorStops`, `fillPriority: 'linear-gradient'`
  - Radial: `fillRadialGradientStartPoint` and `EndPoint` both at the center, `StartRadius: 0`, `EndRadius`, the stops, `fillPriority: 'radial-gradient'`
- Konva color stops are a flat `[offset, color, …]` array; stop opacity goes into the color as `rgba()`.
- Gradients work on every filled node: rect, ellipse, path, freehand stroke, text and page background.

**Editing**

- Properties panel: a Fill type switch (None, Solid, Linear, Radial), a stop bar to add, drag and delete stops, and color plus opacity per stop. A reverse button flips the stops.
- On the canvas, a gradient overlay appears when the fill is a gradient and one object is selected. Linear: two draggable end points on a line. Radial: a center point and a radius handle. Shift snaps the linear angle to 45°.
- A gradient drag is one gesture, so one undo step.

**SVG export**

- Each gradient fill becomes a `<linearGradient>` or `<radialGradient>` in `<defs>` with a unique id, referenced by `fill="url(#id)"`. Stops use `stop-color` and `stop-opacity`.
- Export with `gradientUnits="userSpaceOnUse"` and the same local-pixel coordinates used for Konva. `objectBoundingBox` would stretch radial gradients into ellipses on non-square shapes and no longer match the canvas.
- SVG import reads simple linear and radial gradients back into `Paint`; anything with `gradientTransform` beyond translate and scale falls back to the first stop's color.

## Boolean operations

Booleans run through Paper.js (`paper`), loaded with a dynamic `import()` on first use so it never weighs on startup. Results are ordinary `path` nodes, so they stay node-editable.

| Operation | Shortcut           | Result                                           |
| --------- | ------------------ | ------------------------------------------------ |
| Union     | Ctrl/Cmd + Alt + U | One shape covering all selected shapes           |
| Subtract  | Ctrl/Cmd + Alt + S | The bottom-most shape minus every shape above it |
| Intersect | Ctrl/Cmd + Alt + I | Only the area all shapes share                   |
| Exclude   | Ctrl/Cmd + Alt + X | Areas covered an odd number of times             |

**Pipeline** (`lib/boolean/booleanOp.ts`)

1. Set up Paper once, headless: `paper.setup(new paper.Size(1, 1))`.
2. Convert each selected node to a Paper `Path` or `CompoundPath` in page coordinates, with its transform applied. Rect, ellipse and line go through "convert to path" first; a freehand stroke uses its perfect-freehand outline.
3. Clean the inputs with `resolveCrossings()` and `reorient()`, so self-intersecting freehand outlines don't break the operation.
4. Fold the operation across the shapes in z-order: `unite`, `subtract`, `intersect` or `exclude`.
5. Convert the result back: each child path of the result becomes a contour, and each segment's `point`, `handleIn` and `handleOut` map directly to an `Anchor`.
6. Replace the inputs with one `path` node at the bottom-most input's z-position, with its style. The whole operation is one undo step.

**Rules**

- Enabled only for 2+ selected rect, ellipse, line, path or stroke nodes. Text and images disable the commands until "text to outlines" exists.
- Results from freehand strokes can carry hundreds of anchors. Offer "Simplify" (Paper's `simplify(2.5)`) in the context menu, not automatically.
- Results can have holes, which is why v3 paths hold several contours with a fill rule (Model changes).

## Image import and assets

Image bytes never live in the `Doc`. They are stored once as blobs in IndexedDB, keyed by their SHA-256 hash, and image nodes point to them by that id.

**Import**

- Three ways in: the file picker, drag-and-drop onto the canvas, and paste (Ctrl/Cmd + V) from the clipboard. PNG, JPEG and WebP become image nodes; SVG files go through the v2 SVG importer instead.
- Decode with `createImageBitmap`. If the longer side exceeds 4096 px, downscale in a Web Worker with `OffscreenCanvas` and re-encode (JPEG at 0.9 for photos, PNG when the image has transparency).
- Hash the final bytes with `crypto.subtle.digest('SHA-256', …)`. A known hash reuses the existing asset, so pasting the same image twice stores it once.
- New images land centered on the page, scaled down to fit inside 80% of it.

**Rendering**

- An `assetUrls` cache maps asset ids to object URLs and decoded `HTMLImageElement`s. Konva `Image` nodes draw from it.
- While an asset loads, draw a gray placeholder of the right size.
- Revoke an object URL when no node in the document or the undo history uses its asset.

**Crop**

- Double-click an image (or press Enter) to enter crop mode: the full image shows dimmed, with a crop box on top. Drag the box handles to crop, drag the image to reposition it inside the box. Enter applies, Esc cancels.
- The crop is stored in source-image pixels and maps straight to Konva `Image`'s `crop` attribute.
- "Reset crop" restores the full image.

**Storage and files**

- Autosave writes the doc to `painter:v3` and each asset to `asset:<sha256>` with `idb-keyval`. Call `navigator.storage.persist()` once so the browser doesn't evict images under storage pressure.
- On start, delete stored assets that the loaded doc no longer references.
- Save writes a `.painter` file: a zip built with `fflate` holding `doc.json` and `assets/<sha256>.<ext>`. Open accepts `.painter` and v2's `.painter.json`.
- SVG export embeds images as base64 `data:` URLs inside `<image>`; a cropped image is wrapped in a nested `<svg>` whose `viewBox` is the crop rectangle.

## PDF export

PDF reuses the SVG exporter: each page becomes an SVG, and `svg2pdf.js` draws it into a `jsPDF` page as real vectors. Both libraries load on first export.

**Pipeline** (`lib/pdf/exportPdf.ts`)

1. Build each page's SVG with `exportSvg(page, { embedImages: true })` and parse it into an element with `DOMParser`.
2. Create the document with the first page's size in points: `new jsPDF({ unit: 'pt', format: [w * 0.75, h * 0.75] })`. CSS px to pt is × 0.75.
3. For each page, `addPage` at that page's size (except the first), then `await pdf.svg(svgEl, { x: 0, y: 0, width: w * 0.75, height: h * 0.75 })`.
4. Save as `<document name>.pdf`.

**Export dialog:** all pages or a range ("1-3, 5"), and Vector (default) or Image mode. A progress bar runs during export.

**Fonts**

- jsPDF only knows its built-in fonts. Map Arial and Helvetica to Helvetica, Times New Roman to Times, Courier New to Courier.
- Any other font needs its TTF shipped in `public/fonts/` and registered with `addFileToVFS` and `addFont` before export. Text stays selectable and searchable.
- Arabic and other right-to-left text need an embedded TTF that covers the script, plus a real test; check jsPDF's output early and use Image mode for those pages if shaping is wrong.

**Image mode (fallback):** render each page with an offscreen Konva stage at 300 dpi (pixelRatio 3.125) and place it with `addImage` as JPEG. It looks exactly like the screen, but text is no longer selectable and files are larger.

Gradients, opacity, images and compound paths with holes all go through `svg2pdf.js`. Confirm each in the M21 test document.

## Milestones

Seven milestones, one per agent session, continuing from M14. The model change comes first because every later feature depends on it; PDF comes last because it exercises all the others. Each ends only when its check passes and `lint`, `test` and `build` are green.

1. **M15 · Model v3 and pages.** v3 types, v2 → v3 migration, `currentPageId`, pages panel with thumbnails, size presets and custom sizes, move/copy to page, per-page PNG and SVG export. Paths render from `contours` with `fillRule`.
   - Done when: a v2 document opens as one 1600 × 1000 page that looks unchanged, and add, duplicate, delete, reorder and resize page are each one undo step.
2. **M16 · Snapping.** `lib/snap/` engine with unit tests, smart guides in the overlay, move and resize snapping, Ctrl/Cmd to bypass, View toggle, optional grid.
   - Done when: objects snap to page edges, page center and each other within 6 screen px at 25%, 100% and 400% zoom.
3. **M17 · Align, distribute and numeric transform.** Six align and two distribute commands with shortcuts and toolbar buttons; X, Y, W, H and rotation fields.
   - Done when: commands give correct results on rotated objects in unit tests, and each is one undo step.
4. **M18 · Gradients.** `Paint` rendering in Konva, fill type switch and stop bar, on-canvas handles, page background gradients, SVG export and import.
   - Done when: linear and radial gradients on a rect, a circle, a path and text look the same on the canvas, in the PNG and in the SVG opened in Chrome and Inkscape.
5. **M19 · Boolean operations.** Lazy-loaded Paper.js pipeline, four operations with shortcuts and menu items, Simplify.
   - Done when: subtracting a circle from a rect gives a node-editable path with a hole, a union with a freehand stroke works, and `paper` is absent from the initial bundle.
6. **M20 · Images.** Import by picker, drop and paste; worker downscaling; asset store with dedupe and cleanup; crop mode; `.painter` zip save and open.
   - Done when: a 20 MB phone photo imports without freezing the UI, survives a refresh and a `.painter` round trip, and crops correctly in PNG and SVG.
7. **M21 · PDF and release.** Export dialog, vector and image modes, font mapping and one embedded TTF, Playwright suite covering pages, snapping, gradient, boolean, image import and PDF download.
   - Done when: a 3-page A4 test document with gradients, a cropped image, a boolean shape and text opens in Chrome and Acrobat, matches the screen, and its text is selectable.

**Driving the agent:** append this plan to `CLAUDE.md` / `AGENTS.md` below the v2 plan, and reuse the same session prompt with the new milestone number.

### Definition of done

- [ ] v2 documents open unchanged as a single page
- [ ] Pages can be added, sized, reordered and exported one by one or as a PDF
- [ ] Snapping, align and distribute behave the same at every zoom level
- [ ] Gradients match across canvas, PNG, SVG and PDF
- [ ] Boolean results are editable paths, holes included
- [ ] Images survive refresh, `.painter` save/open and every export format
- [ ] `lint`, unit tests and the Playwright suite pass from a clean clone

## Gotchas and open decisions

Most v3 bugs will come from coordinate spaces (box units, page units, PDF points) and from memory held by images; give these to the agent up front.

**Gotchas**

- **Booleans need holes in the model first.** A single `anchors` list can't hold a donut. `contours` + `fillRule` must land in M15, not M19.
- **Radial gradients stretch in SVG.** `objectBoundingBox` turns circles into ellipses on non-square shapes. Export with `userSpaceOnUse` and pixel coordinates.
- **Gradient points drift on resize.** Store them in box units and convert at render time; never store Konva's pixel points.
- **jsPDF flips landscape pages.** With a `[w, h]` format it defaults to portrait and swaps the sides. Pass `orientation: w > h ? 'landscape' : 'portrait'` for every page.
- **Text falls back to Helvetica in PDF.** Unregistered fonts are silently replaced. Warn in the export dialog when a page uses an unmapped font.
- **Huge photos crash mobile Safari.** iOS caps canvas and image memory. The 4096 px downscale is required, not optional.
- **Undo brings back a deleted image.** Asset cleanup must keep any asset referenced by the undo history in the current session.
- **Object URLs leak.** Revoke them when an asset's last reference goes, or memory grows with every paste.
- **Snapping lags with many objects.** Collect targets once per drag, only for objects in the viewport. Past about 1,000 objects, put them in an `rbush` spatial index.
- **Paper.js chokes on messy outlines.** Run `resolveCrossings()` and `reorient()` before every operation, and catch errors so a failed operation changes nothing.
- **Hashing and storage APIs need a secure context.** `crypto.subtle` (the SHA-256 asset ids) and `navigator.storage.persist()` are missing on plain-http LAN URLs such as `npm run dev -- --host`, as `crypto.randomUUID()` is. Feature-detect them, with a JS hash fallback for asset ids.

**Open decisions**

| Decision        | Plan's pick                                | Alternative                                             |
| --------------- | ------------------------------------------ | ------------------------------------------------------- |
| Page view       | One page at a time                         | Canva-style vertical scroll through all pages           |
| Booleans        | Destructive: inputs replaced by the result | Live boolean groups that stay editable (much more work) |
| Images in files | `.painter` zip with separate asset files   | Base64 inside JSON: simpler, about 33% larger           |
| PDF mode        | Vector by default, image mode as fallback  | Image only: exact match, no selectable text             |
| PDF library     | jsPDF + svg2pdf.js                         | pdf-lib with a hand-written SVG-to-PDF drawer           |

**New libraries** (latest stable, pinned): `paper` and `jspdf` + `svg2pdf.js` (all lazy-loaded), `fflate` for the zip, and `rbush` only if snapping needs it.

## Repo notes

- The folder tree above is relative to this repo root.
- The current Vite `react-ts` template ships oxlint; it was replaced with ESLint (flat config) + Prettier to match the stack table.
- `src/lib/persistence.test.ts` and `src/tools/tools.test.ts` are extra unit tests beyond the folder structure above.
- Node ids don't use `crypto.randomUUID()`: it is missing on plain-http LAN URLs such as `npm run dev -- --host`. Use `newNodeId()` from `store/editorStore.ts`.
- `editorStore.ts` doesn't use zustand's immer middleware. Doc edits go through a `commit` helper that runs immer's `produce`, so it can compare the doc before and after and skip no-op edits in history.
- The store also holds UI state that is neither in history nor autosaved: `draft` (the stroke being drawn, committed by one `addNodes` on pointer-up), `erasing` (ids the eraser has touched, rendered dimmed), `viewport` (the measured Stage size and v1's fit scale, set by `useViewport`), `marquee` (the select tool's drag rectangle, and the text tool's width box), `clipboard` (copied nodes), `editingText` (the text the textarea overlay edits) and `textStyle` (color and font for new text). The clipboard is in-app because `navigator.clipboard` needs a secure context, which LAN http lacks.
- `src/lib/geometry/transform.ts` (+ test) is an extra file: `bakeTransform` turns a Transformer's result into node changes, and `normalizeRotation` keeps degrees in (-180, 180]. It also holds the transforms through groups: `composeTransform`, its inverse `relativeTransform`, `absoluteTransform(nodes, id)` (a node on the canvas) and `deltaInParent` (a canvas move as the node's group sees it).
- `ToolController.picksNodes` is an addition to the plan's interface: the content layer listens, and pointer-downs carry `target`, only for those tools, so drawing never pays for Konva's hit canvas. Konva draws the hit canvas on the next frame after a tool switch.
- After `transformend`, `SelectionOverlay` sets the Konva node's attrs to the model's values itself: react-konva only applies props that differ from its last render, so a baked scale of 1 would otherwise stay at the Transformer's scale.
- The Transformer is padded so a thin stroke's middle handles don't cover it. A multi-selection that contains a rotated node gets corner handles with a fixed ratio, because Konva's axis-aligned box would otherwise skew it, and the model has no skew. Shift snapping rotation to 15° is Konva's own.
- Selection survives tool switches, but its handles show only with the select and hand tools. Selection keys (Delete, arrows, Enter, Esc, Ctrl/Cmd + D, C, X, G, Shift + G, [ and ]) live in `selectTool.onKey`; Ctrl/Cmd + A and + V switch to the select tool. Shift-click on a selected node removes it.
- `view.scale` is relative to the fit, so the screen zoom is `zoomOf(state)` = `viewport.fit × view.scale`. The 0.1×–32× limits and Ctrl/Cmd + 1's 100% are screen zoom. Overlay sizes that must stay constant on screen divide by `zoomOf`, not by `view.scale` alone. On resize, the canvas point in the middle stays put and `view.scale` is kept.
- Holding Space switches the tool to `hand` and switches back on release, so Space-drag is the hand tool's own pan.
- The Stage fills the whole canvas area. The white artboard `Rect` is named `artboard`; the e2e tests locate it through `window.Konva.stages[0]`.
- The brush cursor's radius stays in canvas units, so it matches the stroke at any zoom; only its outline is a constant 1 screen px.
- `src/tools/index.ts` maps each `ToolId` to its controller, so `CanvasStage` never names a tool.
- Autosave uses IndexedDB database `painter`, object store `kv` (idb-keyval `createStore`), key `painter:v2`.
- Migration erases a brush point when it is within eraser radius + brush radius of the eraser path, so a crossing leaves a gap as wide as the v1 eraser even on thick strokes.
- Shape tools draw on a drag. A press that moves less than 3 screen px draws nothing, and rects and ellipses are at least 1 unit on each side, because the Transformer can't scale a zero-size box. The new shape is selected and the tool switches to select, so its handles and style show right away. Rects are placed at their top-left corner, ellipses at their center, and lines at their start with `points` `[0, 0, dx, dy]`. `createRectNode`, `createEllipseNode` and `createLineNode` sit next to `createStrokeNode` in `editorStore.ts`.
- The store's `shapeStyle` is the style for new shapes: a black 4-unit outline and no fill. Like `brush`, it is UI state. Lines take its outline, or black when it has none (`lineStyleOf`).
- The properties panel follows the tool. With select and hand it edits the selection; with brush and eraser, the brush; with the shape tools, `shapeStyle`; with the text tool, `textStyle`, or the text being edited. Rows appear only for properties the selection has: Fill (rects, ellipses, paths, freehand strokes and text, labelled Color when only strokes and text are selected), Stroke and Width (rects, ellipses, lines, paths), Opacity (everything, groups included), Corners (rects), Arrows (lines), and Font, Size (8–200), Style (bold, italic) and Align (text). "None" applies only to rects, ellipses and paths, so freehand strokes and text keep their fill and lines keep their stroke. Edit text, Group, Ungroup (with a group selected), Duplicate, Delete and the z-order buttons sit in the panel header for touch screens.
- `updateNodes(patch, mergeKey?)`: edits with the same key less than `MERGE_MS` (500 ms, formerly `NUDGE_MERGE_MS`) apart, with no other edit between, are one undo step. The panel uses this for slider drags and the color picker, and nudges use the key `nudge`. The panel skips nodes that already have the value, so a click on the current swatch records nothing.
- Under 640 px the tool rail sits above the canvas and wraps to two rows, and the panels share a fixed-height bottom sheet (`h-56`) as two tabs, Properties and Layers, so the canvas doesn't resize when a panel's content changes. From 640 px up, the rail is on the left and a right column holds Properties (a fixed 55% of the height, so the layers don't jump when the selection changes) above Layers. `App.tsx` lays the panels out and holds the tab; `IconButton` is exported from `ToolRail.tsx` for the panels.
- Shapes get `hitStrokeWidth` = max(visible outline, 12 / `zoomOf`) in canvas units. Only `ShapeView` in `NodeView.tsx` subscribes to the zoom, so freehand strokes don't re-render on zoom. Konva's hit canvas fills every shape whose fill is enabled, so unfilled shapes set `fillEnabled={false}` and are hit only on their outline. The object eraser (`nodeHitsSegment`) treats them the same way.
- Shapes keep Konva's default `perfectDrawEnabled`, so a see-through shape with a fill and an outline is drawn once and then faded, like SVG `opacity`. Freehand strokes still turn it off.
- Lines render as Konva `Arrow` with round caps and joins. Arrowheads are `arrowHeadSize(strokeWidth)` = 4 × width + 10 units long and wide, filled with the stroke color; M13's SVG markers should use the same size.
- A single selected line gets two end handles (`line-start`, `line-end`) on the overlay instead of the Transformer. Konva's Transformer refuses to transform a zero-height box, so a level line couldn't be turned or stretched. Dragging an end is one undo step, and Shift snaps it to 45°. A multi-selection that includes lines still uses the Transformer.
- `nodeBounds` includes half the visible outline and the arrowheads. Hit tests sample rounded corners and ellipses as polygons. Shapes aren't rounded on save: they are only a few numbers, and rounding would shift them on reload.
- `bezier-js` 6.1.4 ships no types; `src/lib/geometry/bezier-js.d.ts` declares the parts the editor uses. bezier-js samples curves for the eraser's hit tests (`getLUT`), splits them when an anchor is added (`split`) and finds the nearest point for a double-click (`project`). Path bounds don't use its `bbox()`, which drops an extremum when a curve's cubic term is float noise (a symmetric arch turned 180° came out flat); `cubicBox` in `bounds.ts` solves the derivative itself, with a tolerance, still from the curve's extrema.
- A path is placed at its first anchor (`createPathNode`), and its anchors are relative to that. Paths have at least 2 anchors: the pen drops shorter ones, deleting an anchor below 2 deletes the path, and `sanitizeDoc` drops them. `pathData` rounds to thousandths, and `cachedPathData` keeps it in a `WeakMap` keyed by the anchors array, as stroke outlines are keyed by their points.
- Paths render with miter joins and round caps, so a converted rectangle keeps its sharp corners and a converted line its round ends. M13's SVG export should write `stroke-linejoin="miter" stroke-linecap="round" stroke-miterlimit="10"`: SVG's default miter limit is 4, canvas's is 10. `ShapeNode` now includes `path`, so paths share `ShapeView`'s hit outline and `fillEnabled`, and the eraser fills an open path as if it were closed, as canvas and SVG do.
- `ToolController.onHover(e | null)` is an addition to the plan's interface: pointer moves with nothing pressed (mice and pens, not touch), and null when the pointer leaves the canvas. The pen uses it for its rubber band, through the store's `penHover`.
- Pen: the path being drawn is the `draft` and becomes a node with one `addNodes` when it ends, so it is one undo step. A press within 8 screen px (20 for touch) of the first anchor closes the path, and one on the last anchor ends it open, as do Enter and Esc. A second press on a lone first anchor pulls its handles again. Backspace, Delete or Ctrl/Cmd + Z take back the last anchor while drawing. Shift snaps a new anchor to 45° from the last one and a handle to 45°. New paths take `shapeStyle`. A finished path is selected and the tool switches to select, as with shapes. Switching tools keeps the path drawn so far (selected, without switching tools again), and a pinch drops only the anchor its first finger added. The panel's header has a Finish path button (✓) for touch screens.
- Direct select: anchors (`anchor-N`) and handles (`handle-in-N`, `handle-out-N`) are draggable Konva shapes in `PathEditOverlay`, like the line end handles, and each drag is one gesture. Every handle with a length shows, not only the active anchor's, except the outer handles at an open path's ends. The store's `activeAnchor` (`{ id, index }`) is UI state; `select` drops it when its path leaves the selection, and `activeAnchorOf` checks it is still valid after undo. Delete and Backspace delete the active anchor, or else the selection; arrow keys nudge the active anchor on screen (merged under `nudge`), or else the selection; Esc clears the active anchor, then the selection. Clicking a shape that isn't a path selects it; the panel then offers Convert to path.
- A double-click or double-tap is two presses within 400 ms and 6 screen px (24 for touch), told by `doublePressDetector` in `selectTool.ts`. The select tool's double-click goes one level deeper: into a group (selecting its child under the pointer), from a path to direct select, or into a text's editor. Direct select's double-click within max(half the outline, 8 screen px) of a path's outline adds an anchor there: a curve is split exactly and gets a smooth anchor, a straight segment gets a corner.
- With direct select and an active anchor, the panel shows an Anchor row: Corner, Smooth and Symmetric, and Delete anchor for touch screens. Smooth or Symmetric on an anchor without handles pulls out a pair parallel to its neighbors, a third of the way to each (`anchorWithKind`), so a clicked corner can become a curve by touch, where there is no Alt-drag.
- `convertToPath(ids)` is a store action and one undo step: same id, transform and style, a default name becomes "Path", and a line's arrowheads are dropped. A rounded rectangle gets two smooth anchors per corner with quarter-circle handles (0.5523 × radius), merged where they meet. Its button (spline icon) is in the panel header while the selection has a rectangle, ellipse or line.
- `src/components/overlayStyle.ts` is an extra file: the accent color, anchor size and handle grip that `SelectionOverlay` and `PathEditOverlay` share.
- On phones the tool rail has no gaps between tool buttons, narrower separators and 32 px wide tool buttons (`IconButton`'s `narrow`), so the ten tools fit one row from 360 px up; narrower screens wrap the tools.
- A path with no height, such as a converted level line, can't be stretched or turned by the Transformer, for the reason lines got end handles; direct select still edits it.
- `src/lib/geometry/textLayout.ts` (+ test) is an extra file: the web-safe font stacks (`WEB_SAFE_FONTS`), `TEXT_LINE_HEIGHT` (1.2, used by Konva and the textarea; M13's tspans should use it too) and `textLines`, which wraps a text as Konva 10's `wrap="word"` does (longest run that fits, back to its last space or dash; a word wider than the line breaks between characters), measured with canvas `measureText` in Konva's font string. M13 can take its tspans from `textLines`. A text's box is its width by lines × size × 1.2; in Node tests a glyph is 0.6 em.
- Text: a click places a text 10 font sizes wide, its first line centered on the press; a drag sets the width (at least 20 units). With the text tool, a click on a text edits it. The whole edit is one gesture, begun when the editor opens, with typing written to the node: an edit is one undo step, a new text left empty cancels the gesture (no step), an existing one emptied is deleted in that step, and Esc cancels the gesture. When an edit ends the text is selected and the text tool hands over to select. `sanitizeDoc` drops empty text, a leftover of a reload mid-edit.
- `TextEditor` places its textarea from the model (`absoluteTransform` and the view) rather than Konva's `getAbsolutePosition()`, so it follows zoom, pan and resize in the same render. A font under 16 screen px is drawn at 16 and scaled down, since iOS zooms into smaller fields. It focuses in a layout effect, still inside the tap's pointerup, so phones raise the keyboard; for the same reason the select tool opens the editor on a double-click's release. The canvas cancels non-mouse pointerdowns, so a tap's emulated mousedown doesn't take the focus straight back, and a press on the canvas while editing only ends the edit. The canvas box scrolls back to 0 if the browser scrolls it to show the caret. The Konva text is `visible={false}` while edited, and the Transformer hides.
- A single text gets corner handles that keep its ratio (scaling width and font size) and middle-left/right handles that change only its width, re-wrapping live; no top or bottom handles, since its height follows its lines. Konva picks text anywhere in its box, and the eraser does too.
- Selection holds only pickable nodes: visible, unlocked and in no hidden or locked group (`isPickable`). `select` drops the others, and every commit, undo and redo prunes the selection, so hiding or locking a node deselects it. The layers panel can't select them either.
- Groups: `group(ids)` puts a new group (identity transform) where the front-most picked node was, in that node's parent; nodes from other groups keep their place on the canvas. `ungroup(id)` passes the group's transform, opacity, hidden and locked to its children; Ctrl/Cmd + Shift + G ungroups every selected group inside one gesture, so it is one step. A group never stays empty: `deleteNodes`, `moveNodes` and `group` delete groups they empty. `outermost(doc, ids)` drops ids inside other picked groups, for moves, nudges, duplicates and groups.
- A group's scale is baked into its children (`bakeTransforms`): positions scale, and each child bakes the scale along its own axes as `bakeTransform` does (freehand strokes keep it in their transform). Groups therefore always have a scale of 1 and `strokeWidth` stays in canvas units. A turned child can't take a non-uniform scale without skew, so the Transformer keeps the ratio for a group holding children turned by other than multiples of 90° (`isAxisAligned`).
- Entering groups: a click picks the outermost group; once the selection is inside a group (every selected node has that parent), clicks pick that group's child under the pointer until one lands outside it. Esc goes out one level, then clears the selection; Enter edits a selected text or selects a group's children. Moves and nudges of nodes in groups go along the canvas (`deltaInParent`), and the line end handles and direct select's overlay use `absoluteTransform`. Direct select picks the object under the pointer itself, even inside a group.
- `nodeBounds(node, nodes?)` is in the node's parent's coordinates and needs `nodes` for a group (its visible children through its transform, cached until a descendant changes); `canvasBounds(nodes, id)` is any node's box on the canvas.
- The object eraser erases the objects it touches inside groups, one by one, tested where their groups put them, not the whole group; a group it empties goes. Duplicate keeps copies in the original's group, on top; copy takes nodes out of their groups with their canvas transforms, so a paste lands at the top level where they were, offset.
- `moveNodes(ids, parentId, index)` is a store addition for the layers panel: it moves nodes into a group or the root at a z-order index counted without the moved nodes, keeping them in place on the canvas; a move that changes nothing records nothing, and a group can't go into itself.
- Layers panel: front-most on top; groups start open and collapse with their chevron, and a group holding the selection stays open. A click on a name selects (Shift, Ctrl or Cmd toggles) and switches drawing tools to select; a double-click renames, and so do two clicks or taps within 400 ms, timed by the panel itself since phones don't always send dblclick. Eye and lock are ordinary undoable edits. Rows drag with a mouse or pen from anywhere, with a finger only by the grip (`touch-action: none`), so the list still scrolls by touch; dragging a selected row moves the whole selection. A drop on a row's upper half goes above it (in front), its lower half below; on a group row the top quarter is above, the middle inside on top, and the bottom quarter below a closed group or inside an open one.
- Konva applies a group's opacity to each child rather than compositing the group, unlike SVG's `<g opacity>`. The SVG export therefore multiplies a group's opacity into each child's `opacity` and writes no `opacity` on `<g>`, so overlapping children look as they do on screen.
- File menu: Open…, Save, Import SVG…, Export SVG and Export PNG sit behind one File button (menu icon) at the end of the tool rail, where the Export PNG button was, so they fit the phone's second rail row. The menu drops down on phones and opens to the right of the rail from 640 px up; items are 40 px tall, arrow keys move between them, and Esc, a pick or a press outside closes it. Ctrl/Cmd + S saves and + O opens. The e2e helper `fromFileMenu` picks an item; `exportPixels` goes through it.
- `src/lib/fileActions.ts` is an extra file: the menu's and shortcuts' actions (save, open, import, export), which read the store and report problems in a toast. `src/lib/files.ts` is another: `downloadUrl` (also used by `exportPng`), `downloadText`, and `chooseFile`, which keeps one hidden `<input type="file">` in the page, since some mobile browsers drop the change event of a detached input. Each action first ends what the active tool is drawing (its `onCancel`, as a tool switch does), so a pen path in progress is kept.
- The store's `toast` (`{ id, message }`, set by `showToast`) is UI state like the others; `src/components/Toast.tsx` (extra) shows it for 6 s above the bottom sheet on phones, with a Dismiss button, in a `role="status"` live region that stays in the page.
- Save downloads `drawing.painter.json`: `docToJson` in `persistence.ts`, the doc rounded as autosave rounds it. Open reads it with `parseDocFile`, which refuses non-JSON and objects without `version`, `nodes` and `rootIds` ("This file isn't a Simple Painter drawing.") and any version but 2 ("…unknown version (3)."), then runs `sanitizeDoc`. Opening is the store's `replaceDoc(doc)`: one undo step, so Undo brings the previous drawing back; it ends an open gesture first, clears the selection and the active anchor, and keeps the view.
- SVG export (`drawing.svg`): transform parts that change nothing are left out (positions to 3 decimals, rotation 4, scale 6), hidden nodes and groups with nothing visible are skipped, and the background is a `<rect>` first. A rect's `rx` and `ry` are both min(radius, half the shorter side), as Konva clamps. Arrowheads are `<marker>`s in `<defs>`, one per color, width and end: `markerUnits="userSpaceOnUse"`, `orient="auto"` (a start marker's triangle points backwards rather than using SVG 2's `auto-start-reverse`), `style="overflow:visible"`, the triangle filled and outlined in the line's color with round joins, as Konva draws it. Stroked paths get miter joins, round caps and `stroke-miterlimit="10"`.
- SVG text: one `<text>` per node with a `<tspan>` per `textLines` line (none for an empty line), `xml:space="preserve"` and `text-anchor` for center and right. Each `<text>` is written on one line, because whitespace between preserved tspans counts as trailing spaces and moved centered and right-aligned lines left. The first baseline is `firstBaseline` in `textLayout.ts`: Konva 10's (fontBoundingBoxAscent − fontBoundingBoxDescent)/2 of an 'M' plus half the line height, with Konva's fallback 0.91 and 0.21 em without a canvas.
- The e2e suite draws the exported SVG at 3200 × 2000 in Chrome and compares it with the PNG export: shapes, arrows, see-through groups, rotated text and aligned text match apart from anti-aliased edges. Inkscape wasn't available on the M13 machine, so the export is untested there.
- SVG import (`importSvgElement`, with `importSvg` parsing through `DOMParser`; the element interface is minimal so unit tests use a small XML parser in Node): each subpath of a supported shape becomes a path node, with the element's, its groups' and the viewBox's transforms baked into its anchors by svgpath (`abs`, `unarc`, `unshort`, then `transform`); quadratics are raised to cubics, rects get quarter-ellipse corners (0.5523) and ellipses 4 anchors, as Convert to path makes them. Zero-length segments are dropped, a closed subpath ending on its start closes on its first anchor, and anchor kinds follow the curve: smooth where it goes on in the same direction (a curve leaving a straight side too), symmetric when both handles are also equally long, else corner. `<g>` becomes a group with an identity transform and the `<g>`'s opacity; a shape with several subpaths becomes a group of paths, because the model holds one subpath per path, so holes are filled.
- Import styles: fill, stroke, stroke-width, opacity, color, display and visibility from attributes and inline `style` (style wins), with fill, stroke, width and color inherited. Hex and rgb() colors are read by hand, others (named, hsl) through a canvas `fillStyle`; a color's alpha is dropped (fully clear is none), `currentColor` uses `color`, and `url(…)` paints use their fallback color or none. Outline widths scale by √|det| of the baked transforms; a shape without an outline gets the default width of 4, and one with neither fill nor outline is left out. Not read: classes and `<style>`, fill-opacity, stroke-opacity, caps, joins, dashes and fill-rule.
- Import counting: text, image, use, style, a, switch, nested svg and anything else unsupported each count as one skipped element, as does every child of `<defs>` (gradients, markers, clip paths); title, desc, metadata and elements outside the SVG namespace (Inkscape's, sodipodi's) are passed over silently. A first `<rect>` without outline or transform that covers the whole viewBox is a background (the export writes one) and is left out without counting. Lines come in as open 2-anchor paths without arrowheads.
- Import placement: the import's box (outlines included) is kept where it is when it lies on the artboard, so an exported drawing imports exactly on top of itself; one larger than the artboard is scaled down to fit and centered, with the scale baked into anchors and outline widths; one off the artboard is centered. The root viewBox maps to the svg's width and height in absolute units (px, mm, in, ...) centered as `xMidYMid meet`, or stretched for `preserveAspectRatio="none"`. Coordinates are rounded to thousandths. The group is named after the file, added on top as one undo step, selected, and the tool switches to select; a toast says how many elements were skipped. `addNodes` now keeps a node inside its group when the group is in the same batch.
- Eraser modes: the store's `eraserMode` (`'object' | 'split'`, set by `setEraserMode`) is UI state like `brush`: not in history or autosave, kept through tool switches, object again after a reload. Object is the default, so E still does what it has done since M7. With the eraser the properties panel has a Mode row (Object, Split) and a line saying what the mode does; that row and the anchor kinds share `Choices` in `PropertiesPanel.tsx`. A pass keeps the mode it started with.
- Split mode cuts only freehand strokes. Shapes, paths, text and groups are left alone (it never deletes a whole object of another kind; Object mode does that), and so are hidden and locked strokes and strokes in hidden or locked groups. Strokes are cut as the eraser moves, inside one gesture from press to release, so the ink goes under the eraser as in v1 and the pass is one undo step; Esc, a tool switch, a File menu action and a pinch put back what the pass cut (`cancelGesture`). Each pointer segment is tested with `nodeHitsSegment`, as in object mode, before it cuts. Nothing dims in split mode.
- `eraseSplitPlaced(points, size, transform, eraser)` in `eraseSplit.ts` cuts a stroke where it lies on the canvas: its points are placed by its transform through its groups (`absoluteTransform`), cut against the eraser path in canvas units with the ink's half-width scaled by the mean of |scaleX| and |scaleY| (as `nodeHitsSegment` assumes), and the runs mapped back to the stroke's own coordinates. Kept points stay the stroke's own objects; only the points at a cut are new. A cut is therefore as wide as the eraser on a scaled or turned stroke and in a turned group.
- `splitStrokes(cuts)` is a store addition: one commit replaces each stroke by its runs. The first run stays in the stroke (same id, name, style and transform, so its selection and layer row stay); the others are copies with new ids just above it in the same parent, in their order along the stroke. No runs deletes the stroke, and a group it empties goes. `eraseSplit` already drops runs under 2 points, so a dot the eraser touches goes whole.
- A piece's outline is perfect-freehand's for its own points, so its new ends get round caps and its edges near a cut may shift slightly, as with migration. A see-through stroke that crosses itself shows the crossing darker once cut into pieces that overlap there, since each piece fades on its own.
- Release tests in `e2e/draw.spec.ts`: "release: draw a shape, transform it, draw a pen path, undo and download the SVG" walks M14's flow, and "release: every object type turns, restyles, reorders and deletes, one undo step each" runs a stroke, rectangle, ellipse, line, path, text and group through those steps. The v1 migration test also selects, nudges and deletes a migrated stroke. Where an e2e test counts undo steps after a slider, it moves the slider with one key press (PageDown): the 500 ms merge window splits a run of arrow presses on a busy machine.
- `ToolEvent.timeStamp` is an addition to the plan's interface: the pointer event's own `timeStamp` (ms). `doublePressDetector` compares these rather than the time each press is handled, so a quick double-click still counts when a busy main thread (a heavy re-render, a slow phone) handles the second press late; the layers panel times its two-click rename by the clicks' `timeStamp` too. Unit tests set the time in their events (`at()` in `tools.test.ts` reads a clock that `wait` moves on), not with fake timers. In Playwright one `dblclick` sends its presses at once, but separate `mouse.click` calls each wait for the page, so their timestamps follow the handling.
- Re-run after that fix, "a text is placed, typed and edited" still failed in Edge with two workers, from another race: a text hidden while edited gets its hit area back on Konva's next frame, so a double-click right after Esc could hit nothing. The test now waits a frame there, as it does after redo.
- A refresh or a closed tab saves the last 500 ms of edits from `beforeunload`. In Chromium and Edge (Playwright reloads), IndexedDB writes begun in `pagehide`, or in a `visibilitychange` to hidden during unload, never land, while ones begun in `beforeunload` do. `startAutosave` adds its `beforeunload` listener with the debounce timer and removes it when the save starts, so the page has one only while a save is pending, since Firefox keeps a page with a `beforeunload` listener out of its back/forward cache. `pagehide` and `visibilitychange` still flush, for tab and app switches and for iOS Safari, which doesn't reliably fire `beforeunload`. The e2e test "a refresh right after drawing keeps the drawing…" reloads at once after drawing a rectangle; without the `beforeunload` flush it lost the rectangle 5 times out of 5. Before that fix, the e2e tests began polling `savedNodes` (the saved top-level nodes) for the doc they expect before a reload, not a node count an earlier save may already have, since that race made the properties panel test reload old fills in Edge with two workers; the polls stay. Firefox and Safari weren't available to test the flush.
- `playwright.config.ts` runs Chromium only. The M14 release check also ran the suite in the installed Microsoft Edge 155 through a temporary config (`devices['Desktop Edge']`, `channel: 'msedge'`, `--workers=1`): every test passed except that in each fresh Edge process the first download never reached Playwright within the 30 s test timeout; the same test passed on the next runs in that process. Firefox, Inkscape, Android and iOS were not available on that machine.
- Definition of done, as checked in M14 (2026-10-16): the ticked boxes are covered by the e2e suite, which passed from a fresh clone after `npm ci` (lint, 289 unit tests, build, 30 Playwright tests; Playwright's Chromium was already installed). The SVG box stays open for Firefox and Inkscape (Chrome and Edge match the PNG). The input box stays open for pen input, Firefox, Chrome on Android and Safari on iOS: mouse and emulated touch pass in Chrome and Edge on desktop.
