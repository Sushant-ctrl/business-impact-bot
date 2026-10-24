import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: { '/api': 'http://localhost:8787' },
    // Domain logic lives in ../shared and is imported by both the portals and the server.
    fs: { allow: ['..'] },
  },
})
