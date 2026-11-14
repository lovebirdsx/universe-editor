/*---------------------------------------------------------------------------------------------
 *  Completion sentinel reporter for the e2e entry points.
 *
 *  Why: a run that is externally force-killed (Windows console/job teardown, an
 *  unrelated `taskkill /T`, the host app reaping its agent tree) can leave the
 *  shell's exit code at 0 while Playwright never produced a summary. A green exit
 *  code is then a false pass, which is worse than a crash. The runner
 *  (`scripts/e2e/run-e2e.mjs`) therefore requires this file to exist: Playwright
 *  calls `onEnd` only when it actually reached the end of the run (an empty
 *  `--pass-with-no-tests` pass included).
 *
 *  Opt-in through UNIVERSE_E2E_RESULT_FILE so nothing is written by default and
 *  extension suites (which do not go through run-e2e) stay untouched.
 *--------------------------------------------------------------------------------------------*/

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

interface ResultLike {
  readonly status: string
}

export default class E2EResultReporter {
  onEnd(result: ResultLike): void {
    const file = process.env['UNIVERSE_E2E_RESULT_FILE']
    if (file === undefined || file === '') return
    try {
      // Recreate the dir: a cleanup pass removing the runner's sentinel dir must not
      // turn a completed run into a false "interrupted" verdict.
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, JSON.stringify({ status: result.status }))
    } catch (err) {
      // A finished run must not fail on a temp-file problem, but say so: the runner's
      // "missing sentinel" verdict is otherwise indistinguishable from a real kill.
      console.error(`[e2e-result] failed to write ${file}: ${String(err)}`)
    }
  }
}
