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
      // Routing now goes directly to Stadia Maps (api.stadiamaps.com) —
      // no local proxy needed. See VITE_VALHALLA_URL in .env.
    },
  },
})
