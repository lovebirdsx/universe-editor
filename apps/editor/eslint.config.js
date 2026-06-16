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
          ],
        },
      ],
    },
  },
]
