/*---------------------------------------------------------------------------------------------
 *  Tests for test-changed.mjs --check classification. Run with `node --test`.
 *
 *  These guard the safety boundary of the fast path:
 *    1. OVER-scoping is cheap, UNDER-scoping is a false green — anything vitest's
 *       static import graph cannot track (config alias stubs, cross-package dist
 *       imports, deleted sources, vitest/tsconfig/package.json changes) must fall
 *       back to the full turbo run.
 *    2. Command construction: related files go through as forward-slash absolute
 *       paths (the integration config's root is integration/, relative paths are
 *       ambiguous), targeted files stay package-relative.
 *--------------------------------------------------------------------------------------------*/

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isAbsolute } from 'node:path'
import { buildLeafSet, classifyCheck } from '../test-changed.mjs'

const PKGS = [
  {
    name: '@universe-editor/editor',
    root: 'apps/editor',
    deps: ['@universe-editor/platform', '@universe-editor/git'],
    hasTest: true,
  },
  { name: '@universe-editor/platform', root: 'packages/platform', deps: [], hasTest: true },
  {
    name: '@universe-editor/git',
    root: 'extensions/git',
    deps: ['@universe-editor/platform'],
    hasTest: true,
  },
  {
    name: '@universe-editor/perforce',
    root: 'extensions/perforce',
    deps: ['@universe-editor/platform'],
    hasTest: true,
  },
  { name: '@universe-editor/e2e-harness', root: 'packages/e2e-harness', deps: [], hasTest: false },
]
const LEAF = buildLeafSet(PKGS)
const exists = () => true

const changed = (...paths) => paths.map((p) => ({ path: p, deleted: false }))
const classify = (files) => classifyCheck(files, PKGS, LEAF, exists)

test('buildLeafSet: only packages nobody depends on are leaves', () => {
  assert.ok(LEAF.has('@universe-editor/editor'))
  assert.ok(LEAF.has('@universe-editor/perforce'))
  assert.ok(LEAF.has('@universe-editor/e2e-harness'))
  assert.ok(!LEAF.has('@universe-editor/platform'))
  assert.ok(!LEAF.has('@universe-editor/git'))
})

test('pure test-file change → targeted plan, package-relative paths', () => {
  const cls = classify(changed('apps/editor/src/renderer/services/__tests__/foo.test.ts'))
  assert.equal(cls.mode, 'fast')
  assert.equal(cls.plans.length, 1)
  const [plan] = cls.plans
  assert.equal(plan.pkgName, '@universe-editor/editor')
  assert.equal(plan.label, 'unit targeted')
  assert.deepEqual(plan.args, [
    'exec',
    'vitest',
    'run',
    'src/renderer/services/__tests__/foo.test.ts',
  ])
  assert.deepEqual(cls.buildFilters, ['@universe-editor/editor...'])
})

test('editor src change → related plans for BOTH unit and integration domains', () => {
  const cls = classify(changed('apps/editor/src/renderer/services/explorer/explorerService.ts'))
  assert.equal(cls.mode, 'fast')
  const labels = cls.plans.map((p) => p.label).sort()
  assert.deepEqual(labels, ['integration related', 'unit related'])
  const unit = cls.plans.find((p) => p.label === 'unit related')
  assert.deepEqual(unit.args.slice(0, 5), ['exec', 'vitest', 'related', '--run', '--passWithNoTests'])
  const file = unit.args[5]
  assert.ok(!file.includes('\\'), `expected forward slashes, got ${file}`)
  assert.ok(file.endsWith('apps/editor/src/renderer/services/explorer/explorerService.ts'))
  assert.ok(isAbsolute(file), `expected absolute path, got ${file}`)
  const integration = cls.plans.find((p) => p.label === 'integration related')
  assert.ok(integration.args.includes('--config'))
  assert.ok(integration.args.includes('integration/vitest.config.ts'))
  // vitest compiles src directly; only upstream dists are needed, not editor's own build
  assert.deepEqual(cls.buildFilters, ['@universe-editor/editor^...'])
})

test('non-.test helper under __tests__/ → related (statically imported by tests)', () => {
  const cls = classify(changed('apps/editor/src/renderer/services/__tests__/helpers.ts'))
  assert.equal(cls.mode, 'fast')
  assert.ok(cls.plans.some((p) => p.label === 'unit related'))
})

test('integration fixture change → integration related only', () => {
  const cls = classify(changed('apps/editor/integration/fixtures/createTestWorkbench.ts'))
  assert.equal(cls.mode, 'fast')
  assert.deepEqual(
    cls.plans.map((p) => p.label),
    ['integration related'],
  )
})

test('test-stubs change → full (injected via config resolve.alias, not in import graph)', () => {
  assert.equal(classify(changed('apps/editor/test-stubs/monaco-editor.ts')).mode, 'full')
})

test('config-level files → full', () => {
  for (const p of [
    'apps/editor/vitest.config.ts',
    'apps/editor/vitest.renderer-setup.ts',
    'apps/editor/package.json',
    'apps/editor/tsconfig.web.json',
    'apps/editor/integration/vitest.config.ts',
    'apps/editor/integration/tsconfig.json',
    'extensions/perforce/vitest.config.ts',
  ]) {
    assert.equal(classify(changed(p)).mode, 'full', p)
  }
})

test('non-leaf package source → full (downstream imports its dist, out of graph reach)', () => {
  assert.equal(classify(changed('packages/platform/src/base/event.ts')).mode, 'full')
  assert.equal(classify(changed('extensions/git/src/gitService.ts')).mode, 'full')
})

test('leaf extension source → single-domain related with --passWithNoTests', () => {
  const cls = classify(changed('extensions/perforce/src/p4Service.ts'))
  assert.equal(cls.mode, 'fast')
  assert.equal(cls.plans.length, 1)
  assert.equal(cls.plans[0].label, 'test related')
  assert.ok(cls.plans[0].args.includes('--passWithNoTests'))
  assert.deepEqual(cls.buildFilters, ['@universe-editor/perforce^...'])
})

test('global files → full', () => {
  for (const p of ['pnpm-lock.yaml', 'pnpm-workspace.yaml', 'turbo.json']) {
    assert.equal(classify(changed(p)).mode, 'full', p)
  }
})

test('mixed leaf src + non-leaf src → full is contagious', () => {
  const cls = classify(
    changed('apps/editor/src/renderer/main.tsx', 'packages/platform/src/index.ts'),
  )
  assert.equal(cls.mode, 'full')
})

test('e2e / bench / docs / non-test-package files → outside, no plans', () => {
  const cls = classify(
    changed(
      'apps/editor/e2e/specs/smoke.foo.spec.ts',
      'apps/editor/bench/startup.bench.ts',
      'docs/user/getting-started.md',
      'packages/e2e-harness/src/playwrightConfig.ts',
    ),
  )
  assert.equal(cls.mode, 'fast')
  assert.equal(cls.plans.length, 0)
  assert.equal(cls.outside.length, 4)
})

test('deleted source file → full (no import graph for a file that is gone)', () => {
  const cls = classifyCheck(
    [{ path: 'apps/editor/src/renderer/gone.ts', deleted: true }],
    PKGS,
    LEAF,
    () => false,
  )
  assert.equal(cls.mode, 'full')
})

test('deleted test file → skipped, no plans', () => {
  const cls = classifyCheck(
    [{ path: 'apps/editor/src/renderer/__tests__/gone.test.ts', deleted: true }],
    PKGS,
    LEAF,
    () => false,
  )
  assert.equal(cls.mode, 'fast')
  assert.equal(cls.plans.length, 0)
})

test('mixed targeted + related in one package → both plans, ^... build filter', () => {
  const cls = classify(
    changed(
      'apps/editor/src/renderer/services/foo.ts',
      'apps/editor/src/main/__tests__/bar.test.ts',
    ),
  )
  assert.equal(cls.mode, 'fast')
  const labels = cls.plans.map((p) => p.label).sort()
  assert.deepEqual(labels, ['integration related', 'unit related', 'unit targeted'])
  assert.deepEqual(cls.buildFilters, ['@universe-editor/editor^...'])
})

test('empty change set → full (turbo cache semantics decide)', () => {
  assert.equal(classify([]).mode, 'full')
})
