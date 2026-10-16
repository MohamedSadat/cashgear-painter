# Simple Painter

A vector editor in the browser, built with React, TypeScript, Konva and zustand. Draw pressure-aware freehand strokes, rectangles, ellipses, lines and arrows, Bézier paths and text. Every mark is an object you can select, move, resize, rotate, restyle, group, reorder, hide, lock and delete, and every change undoes. Drawings export as PNG and SVG, SVG files import, and a drawing saves and opens as a `.painter.json` file. It works with mouse, touch and pen, on desktop and phone.

The drawing autosaves in the browser (IndexedDB). A drawing from v1 opens once, migrated, with its eraser strokes applied.

The full plan, data model and milestones are in [CLAUDE.md](CLAUDE.md).

## Tools

| Tool          | Key              | What it does                                                                                                                            |
| ------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Select        | V                | Click to select, Shift-click to add or remove, drag on empty canvas for a marquee. Drag to move; handles resize and rotate.             |
| Direct select | A                | Drag a path's anchors and handles; Alt-drag breaks a smooth handle pair. Double-click the outline to add an anchor, Delete removes one. |
| Brush         | B                | Freehand strokes; pens draw with pressure.                                                                                              |
| Eraser        | E                | Two modes in the properties panel: Object deletes every object it touches, Split erases parts of freehand strokes and leaves the rest.  |
| Rectangle     | R                | Drag to draw. Shift makes a square, Alt draws from the center.                                                                          |
| Ellipse       | O                | Same as the rectangle.                                                                                                                  |
| Line / arrow  | L                | Drag to draw; Shift snaps to 45°. Arrowheads are in the properties panel.                                                               |
| Pen           | P                | Click for a corner, drag for a curve. Click the first anchor to close the path; Enter or Esc ends it open.                              |
| Text          | T                | Click to place a text, or drag to set its width, then type. Ctrl/Cmd + Enter or a click elsewhere ends the edit, Esc cancels it.        |
| Hand          | H, or hold Space | Drag to pan.                                                                                                                            |

Double-click goes one level deeper with the select tool: into a group, from a path to direct select, or into a text.

The **Properties** panel styles the selection, or what the active tool draws next: fill, stroke, width, opacity, corner radius, arrowheads and font. Its header has buttons for edit text, group, ungroup, convert to path, duplicate, delete and z-order, for touch screens. The **Layers** panel lists every object, front-most on top: click to select, drag to reorder or move into a group, double-click to rename, and use the eye and lock icons to hide and lock. On a phone the two panels share a bottom sheet as tabs.

## File menu

The File button at the end of the tool rail holds:

| Item        | Shortcut     | What it does                                                               |
| ----------- | ------------ | -------------------------------------------------------------------------- |
| Open…       | Ctrl/Cmd + O | Opens a `.painter.json` drawing, as one undo step                          |
| Save        | Ctrl/Cmd + S | Downloads the drawing as `drawing.painter.json`                            |
| Import SVG… |              | Adds an SVG's shapes and paths as one group; a toast says what was skipped |
| Export SVG  |              | Downloads `drawing.svg`, 1600 × 1000                                       |
| Export PNG  |              | Downloads `painting.png`, 3200 × 2000 with a white background, at any zoom |

## Shortcuts

| Keys                               | What they do                                          |
| ---------------------------------- | ----------------------------------------------------- |
| Ctrl/Cmd + Z                       | Undo                                                  |
| Ctrl/Cmd + Shift + Z, or Ctrl + Y  | Redo                                                  |
| Delete or Backspace                | Delete the selection                                  |
| Arrow keys, Shift + arrow keys     | Nudge by 1 or 10 units                                |
| Ctrl/Cmd + A                       | Select all                                            |
| Ctrl/Cmd + C, X, V                 | Copy, cut and paste                                   |
| Ctrl/Cmd + D                       | Duplicate                                             |
| Ctrl/Cmd + G, Ctrl/Cmd + Shift + G | Group, ungroup                                        |
| Ctrl/Cmd + ] and [                 | Bring forward, send backward (add Shift: front, back) |
| Enter                              | Edit the selected text, or select a group's contents  |
| Esc                                | Leave a group, then clear the selection               |
| Ctrl/Cmd + wheel, or pinch         | Zoom around the pointer, 10% to 3200%                 |
| Wheel, two fingers                 | Pan                                                   |
| Ctrl/Cmd + 0, Ctrl/Cmd + 1         | Fit the artboard, zoom to 100%                        |
| [ and ]                            | Smaller and larger brush or eraser                    |

Shortcuts don't reach the canvas while a text field has focus.

## Scripts

| Command          | What it does                                                                                                        |
| ---------------- | ------------------------------------------------------------------------------------------------------------------- |
| `npm run dev`    | Dev server (add `-- --host` to try it on a phone on the same network)                                               |
| `npm run build`  | Type-check and build static files into `dist/`                                                                      |
| `npm run lint`   | ESLint                                                                                                              |
| `npm run format` | Prettier                                                                                                            |
| `npm run test`   | Vitest unit tests                                                                                                   |
| `npm run e2e`    | Playwright tests in Chromium; builds and serves the app on port 4173 (first run: `npx playwright install chromium`) |
