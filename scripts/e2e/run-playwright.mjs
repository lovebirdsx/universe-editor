/*---------------------------------------------------------------------------------------------
 *  run-playwright.mjs — wrapper for the package-level `playwright test` calls.
 *
 *  Why: a force-killed runner (Windows console/job teardown, an unrelated
 *  `taskkill /T`, the host app reaping its agent tree) can leave the tracked shell
 *  exiting 0 with no Playwright output at all — a real failure then looks green.
 *  The harness reporter writes UNIVERSE_E2E_RESULT_FILE from `onEnd`, so a zero
 *  exit code without that file is treated as an interrupted run.
 *
 *  Usage (package.json scripts):
 *    node ../../scripts/e2e/run-playwright.mjs test -c e2e/playwright.config.ts ...
 *
 *  `--ui` is exempt: the interactive UI closes on user action, so the sentinel is
 *  not a completion proof there.
 *--------------------------------------------------------------------------------------------*/

import { spawnSync } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { classifyChildResult } from './run-e2e.mjs'
import { mkTempDir } from '../lib/temp-root.mjs'

const args = process.argv.slice(2)
if (args.length === 0) {
  console.error('run-playwright: missing playwright arguments')
  process.exit(1)
}

const interactive = args.includes('--ui')
const resultDir = mkTempDir('ue-e2e-result-')
const resultFile = join(resultDir, 'result.json')

const result = spawnSync('pnpm', ['exec', 'playwright', ...args], {
  stdio: 'inherit',
  shell: process.platform === 'win32',
  env: { ...process.env, UNIVERSE_E2E_RESULT_FILE: resultFile },
})

const outcome = classifyChildResult({
  label: 'playwright',
  status: result.status,
  signal: result.signal,
  error: result.error === undefined ? undefined : result.error.message,
  ...(interactive ? {} : { resultFileExists: existsSync(resultFile) }),
})
rmSync(resultDir, { recursive: true, force: true })
if (outcome.message !== undefined) console.error(`run-playwright: ${outcome.message}`)
process.exit(outcome.exitCode)
