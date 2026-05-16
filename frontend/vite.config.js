import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // FastAPI backend (running on host via Docker)
      '/api': {
        target: 'http://localhost:8000',
        changeOrigin: true,
      },
      // Valhalla routing engine (running on host via Docker).
      // Strip the /valhalla prefix so the upstream sees /route, /status, etc.
      '/valhalla': {
        target: 'http://localhost:8002',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/valhalla/, ''),
      },
    },
  },
})
