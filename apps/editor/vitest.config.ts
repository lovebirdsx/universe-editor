import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'

const monacoStub = fileURLToPath(new URL('./test-stubs/monaco-editor.ts', import.meta.url))
const workerStub = fileURLToPath(new URL('./test-stubs/monaco-worker.ts', import.meta.url))

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
        resolve: {
          alias: [
            {
              find: /^monaco-editor\/esm\/.+\?worker$/,
              replacement: workerStub,
            },
            { find: /^monaco-editor$/, replacement: monacoStub },
          ],
        },
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
