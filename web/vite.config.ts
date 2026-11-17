/// <reference types="vitest/config" />
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

const backend = 'http://localhost:8000'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  server: {
    proxy: {
      '/chat': backend,
      '/scores': backend,
      '/hubs': backend,
      '/health': backend,
    },
  },
  // One app chunk (React, AI SDK, shadcn/Base UI, Recharts, markdown) is ~360 kB gzipped; acceptable for an internal analyst tool.
  build: { outDir: 'dist', emptyOutDir: true, chunkSizeWarningLimit: 1400 },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    css: false,
  },
})
