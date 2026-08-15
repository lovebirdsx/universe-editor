import reactConfig from '@universe-editor/config-eslint/react'
import {
  pathIdentityRestrictedImports,
  schemeAgnosticRestrictedSyntax,
} from '@universe-editor/config-eslint'

/** @type {import('eslint').Linter.Config[]} */
export default [
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/.turbo/**', '**/*.d.ts'],
  },
  ...reactConfig,
  // Ported VSCode observableInternal code: relax rules that conflict with upstream style.
  {
    files: ['packages/platform/src/base/observable/**'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
      '@typescript-eslint/no-empty-object-type': 'off',
      '@typescript-eslint/no-namespace': 'off',
      '@typescript-eslint/no-unsafe-function-type': 'off',
    },
  },
  // Package boundary guardrails. Locked in while implemented usage is zero (04·任务3)
  // so the four invariants can't silently regress. Each block redefines
  // `no-restricted-imports`, which flat config REPLACES rather than merges, so the
  // shared path-identity paths are folded back in every time.
  {
    // packages/** and extensions/** must never reach up into the app.
    files: ['packages/**/*.{ts,tsx}', 'extensions/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [...pathIdentityRestrictedImports.paths],
          patterns: [
            {
              group: [
                '**/apps/**',
                'apps/**',
                '@universe-editor/editor',
                '@universe-editor/editor/**',
              ],
              message:
                'Reusable packages must not import from apps/ — the dependency direction is apps → packages, never the reverse.',
            },
          ],
        },
      ],
    },
  },
  {
    // platform is the zero-dependency kernel: it must not import any other
    // workspace package (that would invert the layering it sits at the bottom of).
    files: ['packages/platform/src/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [...pathIdentityRestrictedImports.paths],
          patterns: [
            {
              group: ['@universe-editor/*'],
              message:
                'platform is the zero-dependency kernel — it must not import other @universe-editor/* packages. Keep new shared primitives inside platform, or invert the dependency.',
            },
            {
              group: ['**/apps/**', 'apps/**'],
              message: 'platform must not import from apps/.',
            },
          ],
        },
      ],
    },
  },
  {
    // The kernel is scheme-agnostic: any resource reaching it may be served by a
    // non-local filesystem provider, and `.fsPath` silently folds the authority
    // into the path for those. Banned here so remote-capable code can't regress;
    // the exempt files below are the deliberate chokepoints.
    files: ['packages/platform/src/**/*.{ts,tsx}'],
    ignores: [
      // Defines the getter itself.
      'packages/platform/src/base/uri.ts',
      // Single private `fsPath()` helper that throws on a non-`file:` scheme;
      // every `${workspaceFolder}`-style variable resolves through it.
      'packages/platform/src/configurationResolver/variableResolver.ts',
      // Guarded ternary: `scheme === 'file' ? fsPath : path`.
      'packages/platform/src/undoRedo/undoRedoService.ts',
      // Guarded scheme check (`uri.scheme !== REMOTE_SCHEME` throws first): the
      // one place a remote-ssh URI is translated to its server-local fsPath.
      'packages/platform/src/remote/remoteUri.ts',
      'packages/platform/src/**/__tests__/**',
      'packages/platform/src/**/*.test.{ts,tsx}',
    ],
    rules: {
      'no-restricted-syntax': ['error', ...schemeAgnosticRestrictedSyntax],
    },
  },
]
