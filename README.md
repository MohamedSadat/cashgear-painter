# Simple Painter

A browser painter built with React, Konva and perfect-freehand: smooth pressure-aware strokes, an eraser, undo/redo, PNG export and autosave, on desktop and phone.

The full plan, data model and milestones are in [CLAUDE.md](CLAUDE.md).

## Scripts

| Command          | What it does                                                          |
| ---------------- | --------------------------------------------------------------------- |
| `npm run dev`    | Dev server (add `-- --host` to try it on a phone on the same network) |
| `npm run build`  | Type-check and build static files into `dist/`                        |
| `npm run lint`   | ESLint                                                                |
| `npm run format` | Prettier                                                              |
| `npm run test`   | Vitest unit tests                                                     |
| `npm run e2e`    | Playwright smoke test (first run: `npx playwright install chromium`)  |

## Shortcuts

Ctrl/Cmd+Z undo · Ctrl/Cmd+Shift+Z or Ctrl+Y redo · B brush · E eraser · `[` / `]` smaller / larger brush
