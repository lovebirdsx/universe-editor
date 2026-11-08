import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'happy-dom',
    silent: 'passed-only',
    setupFiles: ['./src/test/setup.ts'],
  },
})
