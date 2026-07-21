import reactConfig from '@universe-editor/config-eslint/react'

/** @type {import('eslint').Linter.Config[]} */
export default [
  {
    ignores: ['**/dist/**', '**/out/**', '**/node_modules/**', '**/.turbo/**', '**/*.d.ts'],
  },
  ...reactConfig,
  {
    files: ['**/*.cjs'],
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
  {
    files: ['src/renderer/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@universe-editor/platform',
              importNames: ['canonicalResourceKey'],
              message:
                'canonicalResourceKey 已删除，请用 IUriIdentityService.getComparisonKey / getResourceComparisonKey。',
            },
          ],
          patterns: [
            {
              group: ['**/workbench/**/*Service*'],
              message:
                '*Service.ts 应位于 src/renderer/services/<feature>/，不可放在 workbench/ 下。',
            },
            {
              group: ['**/workbench/**/*Input*'],
              message:
                'EditorInput 类应位于 src/renderer/services/editor/，不可放在 workbench/ 下。',
            },
            {
              group: ['electron', 'electron/*'],
              message:
                'renderer 不可直接 import electron：跨进程能力必须走 IPC 服务（ProxyChannel + shared/ipc/channelNames）。',
            },
            {
              group: ['**/main/**', '../main/*', '../../main/*'],
              message: 'renderer 不可 import main/ 进程代码，依赖只能经 shared/ 与 IPC 通道。',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/renderer/services/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@universe-editor/platform',
              importNames: ['canonicalResourceKey'],
              message:
                'canonicalResourceKey 已删除，请用 IUriIdentityService.getComparisonKey / getResourceComparisonKey。',
            },
          ],
          patterns: [
            {
              group: ['**/workbench/**/*Service*'],
              message: '*Service.ts 应位于 src/renderer/services/<feature>/。',
            },
            {
              group: ['**/workbench/**/*Input*'],
              message: 'EditorInput 类应位于 src/renderer/services/editor/。',
            },
            {
              group: ['**/workbench/**/*.tsx'],
              message:
                'services/ 必须保持视图无关：不可 import workbench/ 下的 .tsx 组件，依赖方向是 workbench → services。',
            },
            {
              group: ['**/workbench/**/*.module.css'],
              message: 'services/ 必须保持视图无关：不可 import workbench/ 下的 CSS module。',
            },
            {
              group: ['electron', 'electron/*'],
              message:
                'renderer 不可直接 import electron：跨进程能力必须走 IPC 服务（ProxyChannel + shared/ipc/channelNames）。',
            },
            {
              group: ['**/main/**', '../main/*', '../../main/*'],
              message: 'renderer 不可 import main/ 进程代码，依赖只能经 shared/ 与 IPC 通道。',
            },
          ],
        },
      ],
    },
  },
  {
    // main process must not reach into renderer/ — the only shared surface is
    // src/shared/ + IPC channels. (electron itself is legitimate in main.)
    files: ['src/main/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/renderer/**', '../renderer/*', '../../renderer/*'],
              message:
                'main 不可 import renderer 代码，跨进程只能经 shared/ 与 IPC 通道（依赖方向 renderer/main → shared）。',
            },
          ],
        },
      ],
    },
  },
]
