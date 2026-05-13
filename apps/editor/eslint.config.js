import reactConfig from '@universe-editor/config-eslint/react'

/** @type {import('eslint').Linter.Config[]} */
export default [
  {
    ignores: ['**/dist/**', '**/out/**', '**/node_modules/**', '**/.turbo/**', '**/*.d.ts'],
  },
  ...reactConfig,
]
