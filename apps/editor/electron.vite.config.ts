import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

const platformSrc = resolve(__dirname, '../../packages/platform/src/index.ts')

// platform/src uses `.js` suffix on relative imports (TS NodeNext convention).
// vite/esbuild need this map to resolve them to the real `.ts` files in dev.
const jsToTsExtensionAlias = {
  '.js': ['.ts', '.tsx', '.js', '.jsx'],
} as const

const decoratorTsconfigRaw = {
  compilerOptions: {
    experimentalDecorators: true,
    useDefineForClassFields: false,
  },
} as const

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: ['@universe-editor/platform'] })],
    resolve: {
      alias: {
        '@universe-editor/platform': platformSrc,
      },
      extensionAlias: jsToTsExtensionAlias,
    },
    esbuild: {
      tsconfigRaw: decoratorTsconfigRaw,
    },
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/main/index.ts') },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/preload/index.ts') },
        output: {
          format: 'cjs',
          entryFileNames: '[name].cjs',
        },
      },
    },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    cacheDir: resolve(__dirname, 'node_modules/.vite-editor'),
    plugins: [react()],
    resolve: {
      alias: {
        '@universe-editor/platform': platformSrc,
      },
      extensionAlias: jsToTsExtensionAlias,
    },
    optimizeDeps: {
      include: [
        'monaco-editor',
        'allotment',
        'lucide-react',
        'react',
        'react-dom',
        'react-dom/client',
      ],
      esbuildOptions: {
        tsconfigRaw: decoratorTsconfigRaw,
      },
    },
    esbuild: {
      tsconfigRaw: decoratorTsconfigRaw,
    },
    server: {
      warmup: {
        // Paths are resolved relative to vite root (src/renderer), not __dirname.
        clientFiles: ['./main.tsx', './workbench/Workbench.tsx'],
      },
    },
    worker: {
      format: 'es',
    },
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/renderer/index.html') },
      },
    },
  },
})
