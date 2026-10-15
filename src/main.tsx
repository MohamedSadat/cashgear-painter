import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { loadStrokes, startAutosave } from './lib/persistence'
import { usePaintStore } from './store/paintStore'

usePaintStore.setState({ strokes: loadStrokes() })
startAutosave(usePaintStore)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
