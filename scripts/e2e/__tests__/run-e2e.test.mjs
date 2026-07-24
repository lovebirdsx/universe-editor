/*---------------------------------------------------------------------------------------------
 *  Tests for run-e2e.mjs scoping rules. Run with `node --test`.
 *
 *  These guard the two failure modes of the changed-spec heuristic:
 *    1. UNDER-scoping: any change outside apps/editor/e2e/specs/*.spec.ts must
 *       force FULL mode — a fixture / harness / src change fans out beyond a
 *       single spec file, and silently running only the specs would skip it.
 *    2. Parse drift: porcelain -z rename entries and untracked specs must be
 *       classified correctly, or the selector quietly picks the wrong set.
 *--------------------------------------------------------------------------------------------*/

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseArgs, parsePorcelainV1z, planChangedSpecs } from '../run-e2e.mjs'

const SPEC = 'apps/editor/e2e/specs/smoke.foo.spec.ts'
const SPEC2 = 'apps/editor/e2e/specs/smoke.bar.spec.ts'

test('parsePorcelainV1z handles modified / untracked / staged entries', () => {
  const raw = ` M ${SPEC}\0?? ${SPEC2}\0M  apps/editor/src/renderer/main.tsx\0`
  assert.deepEqual(parsePorcelainV1z(raw), [SPEC, SPEC2, 'apps/editor/src/renderer/main.tsx'])
})

test('parsePorcelainV1z includes both sides of a rename', () => {
  const raw = `R  ${SPEC}\0apps/editor/e2e/specs/smoke.old.spec.ts\0`
  assert.deepEqual(parsePorcelainV1z(raw), [SPEC, 'apps/editor/e2e/specs/smoke.old.spec.ts'])
})

test('parsePorcelainV1z tolerates empty output and trailing fields', () => {
  assert.deepEqual(parsePorcelainV1z(''), [])
  assert.deepEqual(parsePorcelainV1z(` M ${SPEC}\0\0`), [SPEC])
})

test('plan: only spec changes → exact spec list', () => {
  const plan = planChangedSpecs([SPEC, SPEC2])
  assert.equal(plan.mode, 'specs')
  assert.deepEqual(plan.specs, [SPEC, SPEC2])
})

test('plan: clean tree → full (turbo cache may still make it instant)', () => {
  assert.equal(planChangedSpecs([]).mode, 'full')
})

test('plan: shared e2e infrastructure change → full', () => {
  for (const p of [
    'apps/editor/e2e/fixtures/sharedApp.ts',
    'apps/editor/e2e/pages/WorkbenchPO.ts',
    'apps/editor/e2e/playwright.config.ts',
    'packages/e2e-harness/src/playwrightConfig.ts',
  ]) {
    assert.equal(planChangedSpecs([SPEC, p]).mode, 'full', p)
  }
})

test('plan: any src / other-package change → full', () => {
  assert.equal(planChangedSpecs([SPEC, 'apps/editor/src/renderer/main.tsx']).mode, 'full')
  assert.equal(planChangedSpecs(['packages/platform/src/index.ts']).mode, 'full')
})

test('plan: spec lookalikes outside specs/ → full', () => {
  assert.equal(planChangedSpecs(['apps/editor/e2e/fixtures/smoke.fake.spec.ts']).mode, 'full')
  assert.equal(planChangedSpecs(['extensions/markdown/e2e/specs/smoke.m.spec.ts']).mode, 'full')
  assert.equal(planChangedSpecs(['apps/editor/e2e/specs/README.md']).mode, 'full')
})

test('plan: rename out of specs/ forces full via the old path', () => {
  assert.equal(
    planChangedSpecs(['apps/editor/e2e/specs/smoke.old.spec.ts', 'apps/editor/e2e/fixtures/x.ts'])
      .mode,
    'full',
  )
})

test('parseArgs defaults to root scope and e2e suite', () => {
  assert.deepEqual(parseArgs([]), { scope: 'root', suite: 'e2e', dryRun: false })
})

test('parseArgs reads --scope / --suite / --dry-run in any order', () => {
  assert.deepEqual(parseArgs(['--suite', 'e2ea', '--scope', 'editor', '--dry-run']), {
    scope: 'editor',
    suite: 'e2ea',
    dryRun: true,
  })
})

test('parseArgs rejects unknown scope / suite values', () => {
  assert.throws(() => parseArgs(['--scope', 'extensions']), /--scope/)
  assert.throws(() => parseArgs(['--suite', 'e2e:regression']), /--suite/)
})
