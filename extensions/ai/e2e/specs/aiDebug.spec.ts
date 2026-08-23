/*---------------------------------------------------------------------------------------------
 *  AI debug recording + offline replay smoke test (@p1).
 *
 *  Verifies the AI Debug subsystem end-to-end against a local mock Ollama server
 *  (no API key, no network):
 *    - the AI Debug view + container are registered in the side bar
 *    - a real AI request (commit-message generation) is captured by AiDebugRecorder
 *      with the right purpose, model and streamed response
 *    - that record can be replayed OFFLINE as mock data (no second model call) and
 *      yields the same text it originally streamed
 *
 *  Reuses the commit-message generation chain as the request source because it is
 *  the simplest user-visible action that flows through AiModelMainService (where the
 *  recorder hooks live). Lower-level recorder/replay behaviour is unit-tested.
 *--------------------------------------------------------------------------------------------*/

import { test, expect } from '@playwright/test'
import { closeApp, expectNoLeaks, evaluateWhenRestored } from '@universe-editor/e2e-harness'
import { launchAiApp } from '../fixtures/aiApp.js'
import {
  GENERATED_MESSAGE,
  createDirtyRepo,
  seedAiUserData,
  startMockOllama,
} from '../fixtures/aiWorkspace.js'

const AI_DEBUG_CONTAINER = 'workbench.view.aiDebug'
const AI_DEBUG_VIEW = 'workbench.view.aiDebug.main'

test.describe('@p1 ai debug', () => {
  test('records a real AI request and replays it offline', async () => {
    test.setTimeout(120_000)
    const ollama = await startMockOllama()

    const userDataDir = seedAiUserData('universe-editor-e2e-aidebug-', ollama.url)
    const repoDir = createDirtyRepo('universe-editor-e2e-aidebug-repo-')

    const app = await launchAiApp({ userDataDir })
    try {
      const page = await app.firstWindow()
      await page.waitForLoadState('domcontentloaded')
      await page.waitForFunction(() =>
        Boolean((window as unknown as Record<string, unknown>)['__E2E__']),
      )
      await evaluateWhenRestored(page)

      // 1) The AI Debug view + container are registered in the side bar.
      expect(
        await page.evaluate((id) => window.__E2E__!.getViewContainerByViewId(id), AI_DEBUG_VIEW),
      ).toBe(AI_DEBUG_CONTAINER)
      expect(
        await page.evaluate((id) => window.__E2E__!.getViewIdsByContainer(id), AI_DEBUG_CONTAINER),
      ).toContain(AI_DEBUG_VIEW)

      // Start from a clean recorder so the assertions below see only our request.
      await page.evaluate(() => window.__E2E__!.clearAiDebugRecords())

      // Open the git workspace and wait for the SCM provider + ai extension.
      await page.evaluate((p) => window.__E2E__!.openWorkspace(p), repoDir)
      await expect
        .poll(() => page.evaluate(() => window.__E2E__!.getScmSourceControlCount()), {
          timeout: 60_000,
          message: 'git extension should register a source control for the workspace',
        })
        .toBeGreaterThan(0)
      await expect
        .poll(() => page.evaluate(() => window.__E2E__!.hasCommand('ai.generateCommitMessage')), {
          timeout: 60_000,
          message: 'ai extension should contribute ai.generateCommitMessage',
        })
        .toBe(true)

      // 2) Drive a real generation; it flows through AiModelMainService → recorder.
      await page.evaluate(() => window.__E2E__!.runCommand('workbench.view.scm'))
      const button = page.getByRole('button', { name: 'Generate Commit Message' })
      await expect(button).toBeVisible({ timeout: 15_000 })
      await button.click()

      // The request lands in the recorder, tagged purpose 'commit', status ok, with
      // the streamed text in its preview.
      await expect
        .poll(
          async () => {
            const records = await page.evaluate(() => window.__E2E__!.getAiDebugRecords())
            return records.find((r) => r.purpose === 'commit')
          },
          {
            timeout: 30_000,
            message: 'the commit-message request should be recorded',
          },
        )
        .toMatchObject({
          status: 'ok',
          responsePreview: expect.stringContaining(GENERATED_MESSAGE),
        })

      const records = await page.evaluate(() => window.__E2E__!.getAiDebugRecords())
      const commitRecord = records.find((r) => r.purpose === 'commit')!

      // 3) Replay it offline — no second model call, same streamed text.
      const replayed = await page.evaluate(
        (id) => window.__E2E__!.replayAiDebugRecord(id),
        commitRecord.id,
      )
      expect(replayed).toContain(GENERATED_MESSAGE)

      // Replaying an unknown record yields undefined (the not-found path).
      expect(
        await page.evaluate(() => window.__E2E__!.replayAiDebugRecord('no-such-record')),
      ).toBeUndefined()

      await expectNoLeaks(page)
    } finally {
      await closeApp(app)
      await ollama.close()
    }
  })
})
