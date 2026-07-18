/*---------------------------------------------------------------------------------------------
 *  Tests for affected-e2e-matrix.mjs routing rules. Run with `node --test`.
 *
 *  These guard the two silent-failure modes of the affected heuristic:
 *    1. A kernel/upstream change (platform, e2e-harness) must fan out to the FULL
 *       matrix — losing the `...` dependent-prefix would silently under-test.
 *    2. A change to a core-fixture extension (git / typescript / markdown) must
 *       re-run the core suite — the old hand-kept CORE_EXTRA_PACKAGES list drifted;
 *       now it rides on apps/editor's devDependencies + turbo fanout. We assert the
 *       routing given a fanned-out affected set, and (structurally) that those
 *       extensions are declared deps so the fanout actually happens.
 *--------------------------------------------------------------------------------------------*/

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  CORE_PACKAGE,
  EXTENSION_SUITES,
  EXTERNAL_SUITES,
  e2ePackagesFromPlan,
  computeMatrix,
  computeExternalMatrix,
} from '../affected-e2e-matrix.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(__dirname, '..', '..', '..')

const suiteNames = EXTENSION_SUITES.map((s) => s.name)

test('e2ePackagesFromPlan keeps only real playwright e2e tasks', () => {
  const plan = {
    tasks: [
      { package: '@universe-editor/editor', command: 'playwright test -c e2e/...' },
      { package: '@universe-editor/perforce', command: 'playwright test -c e2e/...' },
      // A package with no e2e script — turbo reports the sentinel command.
      { package: '@universe-editor/platform', command: '<NONEXISTENT>' },
      // A non-playwright command must not count as an e2e suite.
      { package: '@universe-editor/git', command: 'vitest run' },
    ],
  }
  const pkgs = e2ePackagesFromPlan(plan)
  assert.deepEqual([...pkgs].sort(), [
    '@universe-editor/editor',
    '@universe-editor/perforce',
  ])
})

test('e2ePackagesFromPlan tolerates a plan with no tasks', () => {
  assert.equal(e2ePackagesFromPlan({}).size, 0)
  assert.equal(e2ePackagesFromPlan({ tasks: [] }).size, 0)
})

test('--all / no-base forces the FULL matrix (main + nightly safety net)', () => {
  const { core, extensions } = computeMatrix(new Set(), { all: true })
  assert.equal(core, true)
  assert.deepEqual(extensions, EXTENSION_SUITES)
})

test('an upstream/kernel change fans out to core + every extension', () => {
  // Editing platform/e2e-harness makes turbo `...[base]` mark every downstream
  // e2e task affected. The routing must then light up the whole matrix.
  const affected = new Set([CORE_PACKAGE, ...suiteNames])
  const { core, extensions } = computeMatrix(affected)
  assert.equal(core, true)
  assert.deepEqual(extensions, EXTENSION_SUITES)
})

test('changing one extension runs only that extension (no core)', () => {
  const affected = new Set(['@universe-editor/perforce'])
  const { core, extensions } = computeMatrix(affected)
  assert.equal(core, false)
  assert.deepEqual(
    extensions.map((s) => s.name),
    ['@universe-editor/perforce'],
  )
})

test('changing a core-fixture extension re-runs core (via editor fanout)', () => {
  // git/typescript/markdown are devDependencies of apps/editor, so turbo fans a
  // change to them up to the editor e2e task → affected includes CORE_PACKAGE.
  // Here we assert the ROUTING honours that (core=true), plus the extension's own
  // suite runs.
  for (const ext of ['@universe-editor/typescript', '@universe-editor/markdown']) {
    const affected = new Set([CORE_PACKAGE, ext])
    const { core, extensions } = computeMatrix(affected)
    assert.equal(core, true, `${ext} change should re-run core`)
    assert.ok(
      extensions.some((s) => s.name === ext),
      `${ext} change should run its own suite`,
    )
  }
})

test('an empty affected set runs nothing (PR that touches no e2e package)', () => {
  const { core, extensions } = computeMatrix(new Set())
  assert.equal(core, false)
  assert.deepEqual(extensions, [])
})

// --- external (out-of-workspace marketplace) suites ------------------------
// These aren't in turbo, so affectedness is a git path diff, routed by
// computeExternalMatrix.

test('--all forces every external suite', () => {
  assert.deepEqual(computeExternalMatrix([], { all: true }), EXTERNAL_SUITES)
})

test('no changed paths runs no external suite', () => {
  assert.deepEqual(computeExternalMatrix([]), [])
})

test('changing one external extension runs only that suite', () => {
  const external = computeExternalMatrix(['extensions-external/pdf/src/extension.ts'])
  assert.deepEqual(
    external.map((s) => s.name),
    ['pdf'],
  )
})

test('a shared-input change fans out to every external suite', () => {
  for (const shared of [
    'packages/e2e-harness/src/launch.ts',
    'packages/e2e-contract/src/index.ts',
    'apps/editor/src/main/services/extensionHost/extensionHostMainService.ts',
    'packages/extension-host/src/extensionScanner.ts',
    'scripts/e2e/run-external-e2e.mjs',
  ]) {
    assert.deepEqual(
      computeExternalMatrix([shared]),
      EXTERNAL_SUITES,
      `${shared} should fan out to all external suites`,
    )
  }
})

test('an unrelated change runs no external suite', () => {
  assert.deepEqual(computeExternalMatrix(['docs/user/foo.md', 'README.md']), [])
})

// Structural guard: the core-fixture extensions MUST be declared deps of
// apps/editor, otherwise turbo won't fan their changes up to the core e2e task and
// core would silently under-run (the exact drift the old CORE_EXTRA_PACKAGES had).
test('apps/editor declares the extensions its scoped fixtures activate at runtime', () => {
  const editorPkg = JSON.parse(
    readFileSync(join(repoRoot, 'apps', 'editor', 'package.json'), 'utf8'),
  )
  const allDeps = { ...editorPkg.dependencies, ...editorPkg.devDependencies }
  for (const ext of [
    '@universe-editor/git',
    '@universe-editor/typescript',
    '@universe-editor/markdown',
  ]) {
    assert.ok(
      ext in allDeps,
      `${ext} must be a (dev)dependency of @universe-editor/editor so turbo affected re-runs core when it changes`,
    )
  }
})
