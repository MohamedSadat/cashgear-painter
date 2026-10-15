import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { startAutosave } from './lib/persistence'
import { useEditorStore } from './store/editorStore'
import { loadStartupDoc } from './store/migrate'

// The saved drawing loads before the first render, so nothing drawn early can be overwritten by it.
async function start() {
  useEditorStore.setState({ doc: await loadStartupDoc() })
  startAutosave(useEditorStore)

  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
}

void start()
