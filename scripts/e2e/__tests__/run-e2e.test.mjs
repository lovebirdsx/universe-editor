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
import { existsSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { mkTempDir } from '../../lib/temp-root.mjs'
import {
  classifyChildResult,
  normalizeSpecArg,
  parseArgs,
  parsePorcelainV1z,
  planChangedSpecs,
  runChild,
} from '../run-e2e.mjs'

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
  assert.deepEqual(parseArgs([]), { scope: 'root', suite: 'e2e', dryRun: false, specs: [] })
})

test('parseArgs reads --scope / --suite / --dry-run in any order', () => {
  assert.deepEqual(parseArgs(['--suite', 'e2ea', '--scope', 'editor', '--dry-run']), {
    scope: 'editor',
    suite: 'e2ea',
    dryRun: true,
    specs: [],
  })
})

test('parseArgs rejects unknown scope / suite values', () => {
  assert.throws(() => parseArgs(['--scope', 'extensions']), /--scope/)
  assert.throws(() => parseArgs(['--suite', 'e2e:regression']), /--suite/)
})

test('parseArgs collects positional spec args, normalized to repo-relative', () => {
  assert.deepEqual(parseArgs(['specs/smoke.foo.spec.ts', '--dry-run']).specs, [SPEC])
  assert.deepEqual(parseArgs([SPEC, 'e2e/specs/smoke.bar.spec.ts']).specs, [SPEC, SPEC2])
})

test('parseArgs rejects unknown flags instead of silently ignoring them', () => {
  assert.throws(() => parseArgs(['--grep', '@p0']), /unknown flag/)
})

test('normalizeSpecArg accepts the three path forms and backslashes', () => {
  assert.equal(normalizeSpecArg('specs/smoke.foo.spec.ts'), SPEC)
  assert.equal(normalizeSpecArg('e2e/specs/smoke.foo.spec.ts'), SPEC)
  assert.equal(normalizeSpecArg(SPEC), SPEC)
  assert.equal(normalizeSpecArg('specs\\smoke.foo.spec.ts'), SPEC)
})

test('normalizeSpecArg rejects paths outside core specs/ and non-spec files', () => {
  for (const bad of [
    'apps/editor/e2e/fixtures/smoke.fake.spec.ts',
    'extensions/markdown/e2e/specs/smoke.m.spec.ts',
    'apps/editor/e2e/specs/README.md',
    'apps/editor/src/renderer/main.tsx',
  ]) {
    assert.throws(() => normalizeSpecArg(bad), /not a core spec file/, bad)
  }
})

// A green exit code is not proof that Playwright ran: on Windows an externally
// force-killed tree can leave the tracked shell exiting 0. The runner therefore
// requires the harness reporter's onEnd sentinel, and never reports success for a
// run it cannot see finish.
test('classifyChildResult: spawn failure is a failure', () => {
  const outcome = classifyChildResult({
    label: 'playwright',
    status: null,
    signal: null,
    error: 'spawn pnpm ENOENT',
  })
  assert.equal(outcome.exitCode, 1)
  assert.match(outcome.message, /无法启动/)
})

test('classifyChildResult: a signal-killed child is a failure', () => {
  const outcome = classifyChildResult({
    label: 'playwright',
    status: null,
    signal: 'SIGKILL',
    resultFileExists: false,
  })
  assert.equal(outcome.exitCode, 1)
  assert.match(outcome.message, /SIGKILL/)
})

test('classifyChildResult: a null status without a signal is a failure', () => {
  const outcome = classifyChildResult({ label: 'playwright', status: null, signal: null })
  assert.equal(outcome.exitCode, 1)
  assert.match(outcome.message, /没有返回退出码/)
})

test('classifyChildResult: preserves a non-zero exit code', () => {
  const outcome = classifyChildResult({ label: 'playwright', status: 2, signal: null })
  assert.equal(outcome.exitCode, 2)
  assert.equal(outcome.message, undefined)
})

test('classifyChildResult: exit 0 without the Playwright sentinel is a failure', () => {
  const outcome = classifyChildResult({
    label: 'playwright',
    status: 0,
    signal: null,
    resultFileExists: false,
  })
  assert.equal(outcome.exitCode, 1)
  assert.match(outcome.message, /没有产出 Playwright 结果/)
})

test('classifyChildResult: exit 0 with the sentinel passes', () => {
  assert.deepEqual(
    classifyChildResult({ label: 'playwright', status: 0, signal: null, resultFileExists: true }),
    { exitCode: 0 },
  )
})

test('classifyChildResult: no sentinel expected (non-Playwright child) passes on exit 0', () => {
  assert.equal(classifyChildResult({ label: 'turbo e2e', status: 0, signal: null }).exitCode, 0)
})

test('runChild: the per-pass sentinel dir survives until the child writes it', () => {
  // Regression: a pre-spawn cleanup deleted the freshly-created mkdtemp dir, so the
  // reporter's write failed (ENOENT) and a fully green pass was reported as
  // "exit 0 without a Playwright result".
  const resultFile = join(mkTempDir('ue-e2e-result-test-'), 'result.json')
  let dirAliveAtSpawn
  let fileAtSpawn
  const spawn = () => {
    dirAliveAtSpawn = existsSync(dirname(resultFile))
    fileAtSpawn = existsSync(resultFile)
    writeFileSync(resultFile, JSON.stringify({ status: 'passed' }))
    return { status: 0, signal: null }
  }

  const outcome = runChild({ command: 'playwright', args: ['test'], resultFile, spawn })

  assert.equal(dirAliveAtSpawn, true, 'sentinel dir must not be deleted before the child runs')
  assert.equal(fileAtSpawn, false, 'sentinel file must not exist before the run ends')
  assert.deepEqual(outcome, { exitCode: 0 })
  assert.equal(existsSync(dirname(resultFile)), false, 'sentinel dir is cleaned after the pass')
})

test('runChild: exit 0 with no sentinel write is reported as a failure', () => {
  const resultFile = join(mkTempDir('ue-e2e-result-test-'), 'result.json')

  const outcome = runChild({
    command: 'playwright',
    args: ['test'],
    resultFile,
    spawn: () => ({ status: 0, signal: null }),
  })

  assert.equal(outcome.exitCode, 1)
  assert.match(outcome.message, /没有产出 Playwright 结果/)
  assert.equal(existsSync(dirname(resultFile)), false)
})
