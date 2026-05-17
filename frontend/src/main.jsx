import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'

// Persistent basemap tile cache. The SW intercepts CARTO + ArcGIS tile
// requests and serves them from the Cache API on subsequent loads.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('/tile-sw.js')
      .catch((err) => console.warn('Tile cache SW registration failed:', err))
  })
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
