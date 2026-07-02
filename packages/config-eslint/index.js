import tseslint from 'typescript-eslint'
import prettierConfig from 'eslint-config-prettier'
import prettierPlugin from 'eslint-plugin-prettier'

// Guard rails against re-introducing hand-rolled path/URI identity comparison.
// The single source of truth is IUriIdentityService (renderer/main DI) or the
// base kernel functions it wraps — getResourceComparisonKey / isEqualResource /
// isEqualOrParentResource / arePathsEqual / relativePathUnder / getPathComparisonKey.
// See packages/platform/src/uriIdentity.
//
// These selectors target the *identity-key* shape specifically (case-fold of a
// filesystem path), not every toLowerCase/replace — slug builders and model-id
// normalizers legitimately chain those without touching path separators.
const pathIdentityRestrictedSyntax = [
  {
    // `foo.fsPath.toLowerCase()` — folding a filesystem path's case by hand.
    selector:
      "CallExpression[callee.property.name='toLowerCase'][callee.object.type='MemberExpression'][callee.object.property.name='fsPath']",
    message:
      'Do not fold fsPath case by hand. Use IUriIdentityService (isEqual / getComparisonKey) or the base kernel (getResourceComparisonKey), which apply the platform case policy for you.',
  },
  {
    // `x.toLowerCase().replace(/\\/g, '/')` — case-fold chained with a
    // backslash→slash normalize is a hand-rolled path identity key.
    selector:
      "CallExpression[callee.property.name='replace'][arguments.0.regex.pattern='\\\\\\\\'][callee.object.type='CallExpression'][callee.object.callee.property.name='toLowerCase']",
    message:
      'Do not hand-roll a path identity key (toLowerCase().replace(/\\\\/g, ...)). Use IUriIdentityService.getPathComparisonKey / arePathsEqual, or the base getPathComparisonKey.',
  },
  {
    // `x.replace(/\\/g, '/').toLowerCase()` — same key, other order.
    selector:
      "CallExpression[callee.property.name='toLowerCase'][callee.object.type='CallExpression'][callee.object.callee.property.name='replace'][callee.object.arguments.0.regex.pattern='\\\\\\\\']",
    message:
      'Do not hand-roll a path identity key (replace(/\\\\/g, ...).toLowerCase()). Use IUriIdentityService.getPathComparisonKey / arePathsEqual, or the base getPathComparisonKey.',
  },
]

const pathIdentityRestrictedImports = {
  paths: [
    {
      name: '@universe-editor/platform',
      importNames: ['canonicalResourceKey'],
      message:
        'canonicalResourceKey was removed (it folded only the drive letter, disagreeing with platform-aware comparison). Use IUriIdentityService.getComparisonKey / getResourceComparisonKey instead.',
    },
  ],
}

export default tseslint.config(
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
      'no-restricted-syntax': ['error', ...pathIdentityRestrictedSyntax],
      'no-restricted-imports': ['error', pathIdentityRestrictedImports],
    },
  },
  {
    // Tests may hand-roll path normalization in assertion helpers (they compare
    // event paths cross-platform, not app identity), so relax the path-identity
    // syntax guard there. The import guard still applies.
    files: ['**/__tests__/**', '**/*.test.{ts,tsx}'],
    rules: {
      'no-restricted-syntax': 'off',
    },
  },
  prettierConfig,
  {
    plugins: { prettier: prettierPlugin },
    rules: { 'prettier/prettier': 'error' },
  },
)
