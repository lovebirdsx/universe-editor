import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react-oxc'
import { resolve } from 'node:path'
import { readFileSync } from 'node:fs'
import type { Plugin } from 'vite'
import { monacoNlsPlugin } from './build/plugins/monacoNlsPlugin'
import { monacoUnicodeHighlighterPlugin } from './build/plugins/monacoUnicodeHighlighterPlugin'
import { mainHmrPlugin } from './build/plugins/mainHmrPlugin'
import { devRuntimeWatchPlugin } from './build/plugins/devRuntimeWatchPlugin'
import {
  NLS_FILE_SUFFIX,
  patchNlsSource,
} from './src/renderer/workbench/editor/monaco/monacoNlsPatch'

const platformSrc = resolve(__dirname, '../../packages/platform/src/index.ts')
const workbenchUiSrc = resolve(__dirname, '../../packages/workbench-ui/src/index.ts')
const extensionsCommonSrc = resolve(__dirname, '../../packages/extensions-common/src/index.ts')
const REPO_ROOT = resolve(__dirname, '../..')

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

// rolldown-vite drops the `external` arrays electron-vite injects via config-hook
// plugins (the preset + externalizeDeps), so declare them literally: electron +
// every package.json dependency (mirrors externalizeDeps semantics).
const editorPkg = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf-8')) as {
  dependencies?: Record<string, string>
}
const nodeExternal = ['electron', /^electron\/.+/, ...Object.keys(editorPkg.dependencies ?? {})]

export default defineConfig({
  main: {
    plugins: [
      jsToTsResolvePlugin(),
      mainHmrPlugin(),
      devRuntimeWatchPlugin({ repoRoot: REPO_ROOT }),
    ],
    resolve: {
      alias: {
        '@universe-editor/platform': platformSrc,
      },
    },
    build: {
      // Dev only: the main sourcemap (~1.2MB) is dead weight inside the asar in
      // production and inflates Defender's first-run scan.
      sourcemap: process.env['NODE_ENV'] !== 'production',
      externalizeDeps: {
        exclude: [
          '@universe-editor/platform',
          '@universe-editor/extensions-common',
          '@universe-editor/extension-api',
          '@universe-editor/extension-gallery',
          '@universe-editor/extension-packaging',
        ],
      },
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          // Watcher utility process entry — forked by watcherUtilityTransport;
          // must stay a separate chunk so utilityProcess.fork gets a real file.
          watcherHost: resolve(__dirname, 'src/main/services/fileWatcher/watcherHostMain.ts'),
        },
        external: nodeExternal,
      },
    },
  },
  preload: {
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/preload/index.ts') },
        external: nodeExternal,
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
    plugins: [monacoNlsPlugin(), monacoUnicodeHighlighterPlugin(), react(), jsToTsResolvePlugin()],
    resolve: {
      alias: {
        '@universe-editor/platform': platformSrc,
        '@universe-editor/workbench-ui/tokens.css': resolve(
          __dirname,
          '../../packages/workbench-ui/src/theme/tokens.css',
        ),
        '@universe-editor/workbench-ui': workbenchUiSrc,
        '@universe-editor/extensions-common': extensionsCommonSrc,
      },
    },
    optimizeDeps: {
      exclude: [
        '@universe-editor/platform',
        '@universe-editor/workbench-ui',
        '@universe-editor/extensions-common',
      ],
      include: [
        'monaco-editor',
        // Deep `monaco-editor/esm/...` imports (textMateService, monacoSemanticThemeBridge,
        // monacoActionsBridge, ...) bypass the bare `monaco-editor` optimized chunk and
        // otherwise load ~185 raw ESM files one request at a time. Bundle each used
        // entrypoint; rolldown splits their shared internals into common chunks.
        'monaco-editor/esm/vs/base/browser/ui/hover/hoverDelegateFactory.js',
        'monaco-editor/esm/vs/base/common/errors.js',
        'monaco-editor/esm/vs/editor/browser/editorExtensions.js',
        'monaco-editor/esm/vs/editor/browser/services/bulkEditService.js',
        'monaco-editor/esm/vs/editor/browser/services/codeEditorService.js',
        'monaco-editor/esm/vs/editor/common/encodedTokenAttributes.js',
        'monaco-editor/esm/vs/editor/common/languages.js',
        'monaco-editor/esm/vs/editor/common/languages/nullTokenize.js',
        'monaco-editor/esm/vs/editor/common/services/languageFeatures.js',
        'monaco-editor/esm/vs/editor/standalone/browser/standaloneServices.js',
        'monaco-editor/esm/vs/editor/standalone/browser/standaloneThemeService.js',
        'monaco-editor/esm/vs/editor/standalone/common/standaloneTheme.js',
        'monaco-editor/esm/vs/basic-languages/markdown/markdown.js',
        'monaco-editor/esm/vs/platform/commands/common/commands.js',
        'monaco-editor/esm/vs/platform/configuration/common/configuration.js',
        'monaco-editor/esm/vs/platform/hover/browser/hover.js',
        'monaco-editor/esm/vs/platform/instantiation/common/instantiation.js',
        'monaco-editor/esm/vs/platform/list/browser/listService.js',
        '@agentclientprotocol/sdk',
        '@floating-ui/react',
        '@react-aria/focus',
        '@tanstack/react-virtual',
        '@xterm/addon-fit',
        '@xterm/addon-web-links',
        '@xterm/xterm',
        'allotment',
        'jsonc-parser',
        'lucide-react',
        'mermaid',
        'vscode-oniguruma',
        'vscode-textmate',
        'react',
        'react-dom',
        'react-dom/client',
        'react/jsx-dev-runtime',
        'react/jsx-runtime',
      ],
      rolldownOptions: {
        plugins: [
          {
            name: 'universe-editor:monaco-nls',
            load: {
              filter: { id: /nls\.js$/ },
              handler(id) {
                if (!id.replace(/\\/g, '/').endsWith(NLS_FILE_SUFFIX)) return null
                return patchNlsSource(readFileSync(id, 'utf-8'))
              },
            },
          },
        ],
      },
    },
    server: {
      warmup: {
        // Paths are resolved relative to vite root (src/renderer), not __dirname.
        // The three serial module waves of bootstrap (main.tsx static graph →
        // dynamic import('./contributions') → dynamic import('./workbench/Workbench')):
        // warming all three lets the dev server pre-transform them in parallel
        // instead of discovering each wave only when execution reaches its await.
        clientFiles: ['./main.tsx', './contributions/index.ts', './workbench/Workbench.tsx'],
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
