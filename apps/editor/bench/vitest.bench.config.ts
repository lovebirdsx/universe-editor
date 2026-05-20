import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('.', import.meta.url))

export default defineConfig({
  test: {
    name: 'bench',
    environment: 'node',
    root,
    include: ['**/*.bench.ts'],
    reporters: ['verbose'],
  },
})
