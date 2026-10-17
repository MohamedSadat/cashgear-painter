import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { startAssetTracking } from './lib/images/assets'
import { cleanUpAssets, loadStartupDoc, startAutosave } from './lib/persistence'
import { startThumbnails } from './lib/thumbnails'
import { useEditorStore } from './store/editorStore'
import { watchCrop } from './tools/imageCrop'

// The saved drawing loads before the first render, so nothing drawn early can be overwritten by it.
async function start() {
  const doc = await loadStartupDoc()
  useEditorStore.setState({ doc, currentPageId: doc.pages[0].id })
  startAutosave(useEditorStore)
  startThumbnails(useEditorStore)
  startAssetTracking(useEditorStore)
  watchCrop()
  // Stored images the drawing no longer shows: nothing can bring them back now.
  void cleanUpAssets(doc)

  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
}

void start()
