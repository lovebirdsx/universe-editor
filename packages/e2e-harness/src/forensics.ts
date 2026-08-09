/*---------------------------------------------------------------------------------------------
 *  Failure forensics: Playwright's own artifacts are near-useless for this app.
 *  The on-failure screenshot of the Electron window captures a uniformly black
 *  frame (GPU-composited surface — reproduced on Windows and CI Linux alike),
 *  and the error-context aria snapshot is taken AFTER the leak-gate probe has
 *  already unmounted React, so it always shows an empty page. The durable
 *  evidence is the app's own log files under <userData>/logs (renderer /
 *  extension-host / main channels) plus any uncaught renderer exceptions.
 *
 *  Install at fixture setup while the page is live; the returned finalizer
 *  attaches both to the test — call it from teardown, after closeApp when
 *  possible so the log tail is flushed.
 *--------------------------------------------------------------------------------------------*/

import type { Page, TestInfo } from '@playwright/test'
import { cpSync, existsSync } from 'node:fs'
import { join } from 'node:path'

export function installFailureForensics(
  page: Page,
  userDataDir: string,
): (testInfo: TestInfo) => Promise<void> {
  const pageErrors: string[] = []
  const onPageError = (err: Error): void => {
    pageErrors.push(err.stack ?? String(err))
  }
  page.on('pageerror', onPageError)
  return async (testInfo) => {
    page.off('pageerror', onPageError)
    if (testInfo.status === testInfo.expectedStatus) return
    if (pageErrors.length > 0) {
      await testInfo.attach('pageerrors', {
        body: pageErrors.join('\n\n'),
        contentType: 'text/plain',
      })
    }
    const logsDir = join(userDataDir, 'logs')
    if (!existsSync(logsDir)) return
    try {
      // Lands inside the test's output dir → uploaded with the test-results
      // artifact in CI, no workflow change needed.
      cpSync(logsDir, testInfo.outputPath('userdata-logs'), { recursive: true, force: true })
    } catch {
      // Best-effort: a mid-write file lock must not turn forensics into a failure.
    }
  }
}
