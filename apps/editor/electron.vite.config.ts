import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'
import { readFileSync } from 'node:fs'
import type { Plugin } from 'vite'
import { monacoNlsPlugin } from './build/plugins/monacoNlsPlugin'
import { mainHmrPlugin } from './build/plugins/mainHmrPlugin'
import {
  NLS_FILE_SUFFIX,
  patchNlsSource,
} from './src/renderer/workbench/editor/monaco/monacoNlsPatch'

const platformSrc = resolve(__dirname, '../../packages/platform/src/index.ts')

// platform/src uses `.js` suffix on relative imports (TS NodeNext convention).
// Vite 7 removed extensionAlias; use a plugin instead to remap .js → .ts.
function jsToTsResolvePlugin(): Plugin {
  return {
    name: 'universe-editor:js-to-ts-resolve',
    enforce: 'pre',
    async resolveId(id, importer, options) {
      if (importer && id.endsWith('.js') && !importer.includes('node_modules')) {
        const tsId = id.slice(0, -3) + '.ts'
        const resolved = await this.resolve(tsId, importer, { skipSelf: true, ...options })
        if (resolved) return resolved
        const tsxId = id.slice(0, -3) + '.tsx'
        return await this.resolve(tsxId, importer, { skipSelf: true, ...options })
      }
    },
  }
}

const decoratorTsconfigRaw = {
  compilerOptions: {
    experimentalDecorators: true,
    useDefineForClassFields: false,
  },
} as const

export default defineConfig({
  main: {
    plugins: [jsToTsResolvePlugin(), mainHmrPlugin()],
    resolve: {
      alias: {
        '@universe-editor/platform': platformSrc,
      },
    },
    esbuild: {
      tsconfigRaw: decoratorTsconfigRaw,
    },
    build: {
      sourcemap: true,
      externalizeDeps: { exclude: ['@universe-editor/platform'] },
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/main/index.ts') },
      },
    },
  },
  preload: {
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
    publicDir: resolve(__dirname, 'public'),
    cacheDir: resolve(__dirname, 'node_modules/.vite-editor'),
    plugins: [monacoNlsPlugin(), react(), jsToTsResolvePlugin()],
    resolve: {
      alias: {
        '@universe-editor/platform': platformSrc,
      },
    },
    optimizeDeps: {
      exclude: ['@universe-editor/platform'],
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
        plugins: [
          {
            name: 'universe-editor:monaco-nls',
            setup(build) {
              build.onLoad({ filter: /nls\.js$/ }, (args) => {
                if (!args.path.replace(/\\/g, '/').endsWith(NLS_FILE_SUFFIX)) return undefined
                return { contents: patchNlsSource(readFileSync(args.path, 'utf-8')), loader: 'js' }
              })
            },
          },
        ],
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
