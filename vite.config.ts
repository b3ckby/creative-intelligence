import react from '@vitejs/plugin-react'
import { loadEnv } from 'vite'
import { defineConfig } from 'vitest/config'

import { validateSimpleLoginBuildEnvironment } from './src/config/simple-login-build-config.ts'

export default defineConfig(({ mode }) => {
  validateSimpleLoginBuildEnvironment({ ...loadEnv(mode, process.cwd(), ''), ...process.env })
  return {
  root: 'web',
  envDir: '..',
  plugins: [react()],
  build: {
    outDir: '../dist/web',
    emptyOutDir: true,
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      '/organizations': { target: process.env.CREATIVE_INTELLIGENCE_DEV_API_URL ?? 'http://127.0.0.1:3000', changeOrigin: false },
      '/auth': { target: process.env.CREATIVE_INTELLIGENCE_DEV_API_URL ?? 'http://127.0.0.1:3000', changeOrigin: false },
      '/health': { target: process.env.CREATIVE_INTELLIGENCE_DEV_API_URL ?? 'http://127.0.0.1:3000', changeOrigin: false },
      '/media': { target: process.env.CREATIVE_INTELLIGENCE_DEV_API_URL ?? 'http://127.0.0.1:3000', changeOrigin: false },
    },
  },
  preview: {
    host: '127.0.0.1',
    port: 4173,
  },
  test: {
    include: ['src/**/*.test.{ts,tsx}'],
    isolate: false,
  },
  }
})
