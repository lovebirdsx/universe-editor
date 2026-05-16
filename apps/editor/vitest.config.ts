import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'main',
          environment: 'node',
          include: ['src/main/**/*.test.ts', 'src/shared/**/*.test.ts'],
        },
      },
      {
        plugins: [react()],
        test: {
          name: 'renderer',
          environment: 'happy-dom',
          include: ['src/renderer/**/*.test.{ts,tsx}'],
          setupFiles: ['./vitest.renderer-setup.ts'],
        },
      },
    ],
  },
})
