import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'

const monacoStub = fileURLToPath(new URL('./test-stubs/monaco-editor.ts', import.meta.url))
const workerStub = fileURLToPath(new URL('./test-stubs/monaco-worker.ts', import.meta.url))
const standaloneServicesStub = fileURLToPath(
  new URL('./test-stubs/monaco-standalone-services.ts', import.meta.url),
)

// renderer 测试中真正依赖 DOM/Monaco 的 .test.ts。其余 .test.ts 跑在更快的
// renderer-node（纯 node、无 react 插件、无 Monaco 预热）。新增同类文件若漏加，
// 会在 node 环境直接 fail loud，不会静默劣化。
const rendererDomTests = [
  'src/renderer/workbench/editor/monaco/__tests__/overrideServicesInit.test.ts',
  'src/renderer/workbench/panel/terminal/__tests__/terminalClipboard.test.ts',
  'src/renderer/actions/__tests__/agentActions.test.ts',
  'src/renderer/actions/__tests__/editorActions.test.ts',
  'src/renderer/actions/__tests__/historyActions.test.ts',
  'src/renderer/actions/__tests__/preferencesActions.test.ts',
  'src/renderer/contributions/__tests__/AgentFontContribution.test.ts',
  'src/renderer/contributions/__tests__/GitBlameContribution.test.ts',
  'src/renderer/contributions/__tests__/ThemeContribution.test.ts',
  'src/renderer/contributions/__tests__/WindowTitleContribution.test.ts',
  'src/renderer/contributions/__tests__/WorkbenchFontContribution.test.ts',
  'src/renderer/services/acp/__tests__/acpChatWidgetService.test.ts',
  'src/renderer/services/editor/__tests__/FileEditorInput.externalChange.test.ts',
  'src/renderer/services/editor/__tests__/FileEditorInput.test.ts',
  'src/renderer/services/editor/__tests__/UntitledEditorInput.test.ts',
  'src/renderer/services/sessionSwitcher/__tests__/RendererSessionsService.test.ts',
  'src/renderer/services/terminal/__tests__/TerminalXtermService.test.ts',
  'src/renderer/workbench/editor/__tests__/MonacoModelRegistry.test.ts',
]

const monacoAlias = {
  resolve: {
    alias: [
      { find: /^monaco-editor\/esm\/.+\?worker$/, replacement: workerStub },
      {
        find: 'monaco-editor/esm/vs/editor/standalone/browser/standaloneServices.js',
        replacement: standaloneServicesStub,
      },
      { find: /^monaco-editor$/, replacement: monacoStub },
    ],
  },
}

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
        test: {
          name: 'renderer-node',
          environment: 'node',
          include: ['src/renderer/**/*.test.ts'],
          exclude: rendererDomTests,
        },
      },
      {
        plugins: [react()],
        ...monacoAlias,
        test: {
          name: 'renderer-dom',
          environment: 'happy-dom',
          include: ['src/renderer/**/*.test.tsx', ...rendererDomTests],
          setupFiles: ['./vitest.renderer-setup.ts'],
        },
      },
    ],
  },
})
