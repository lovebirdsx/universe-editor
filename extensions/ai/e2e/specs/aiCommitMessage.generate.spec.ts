/*---------------------------------------------------------------------------------------------
 *  AI commit-message end-to-end generation smoke test (@p0).
 *
 *  Drives the full generation chain in a real git workspace, against a local mock
 *  Ollama server (no API key, no network): clicking the inline button runs
 *  `ai.generateCommitMessage`, which flows extension → ai namespace → host →
 *  AiModelClientService → IPC → AiModelMainService → OllamaProvider.sendRequest,
 *  streams the model output back, and writes it into the commit input box via
 *  `git.setCommitMessage`. We assert the streamed message lands in the input box.
 *
 *  Why Ollama and not OpenAI: the OpenAI provider needs an API key. Ollama needs
 *  none and the generation flow is provider-agnostic (it picks the first available
 *  model), so a mock Ollama backend covers the whole chain.
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

test.describe('@p0 ai commit message generation', () => {
  test('streams the model output into the commit input box', async () => {
    // Heavier than the button-presence smoke test: it boots Electron, activates
    // the git + ai extensions, and runs a real generation. Give it headroom for
    // cold starts under parallel load.
    test.setTimeout(120_000)
    const ollama = await startMockOllama()

    const userDataDir = seedAiUserData('universe-editor-e2e-aigen-', ollama.url)
    const repoDir = createDirtyRepo('universe-editor-e2e-aigen-repo-')

    const app = await launchAiApp({ userDataDir })
    try {
      const page = await app.firstWindow()
      await page.waitForLoadState('domcontentloaded')
      await page.waitForFunction(() =>
        Boolean((window as unknown as Record<string, unknown>)['__E2E__']),
      )
      // Self-launched spec: whenRestored() can race the startup navigation and
      // throw "Execution context was destroyed". Use the hardened helper.
      await evaluateWhenRestored(page)

      // Open the git workspace and wait for the SCM provider to register.
      await page.evaluate((p) => window.__E2E__!.openWorkspace(p), repoDir)
      await expect
        .poll(() => page.evaluate(() => window.__E2E__!.getScmSourceControlCount()), {
          timeout: 60_000,
          message: 'git extension should register a source control for the workspace',
        })
        .toBeGreaterThan(0)

      // Wait for the ai extension to contribute its command.
      await expect
        .poll(() => page.evaluate(() => window.__E2E__!.hasCommand('ai.generateCommitMessage')), {
          timeout: 60_000,
          message: 'ai extension should contribute ai.generateCommitMessage',
        })
        .toBe(true)

      // Reveal the SCM view, then click the inline generate button. The button's
      // onRun is fire-and-forget, so this does not block on generation.
      await page.evaluate(() => window.__E2E__!.runCommand('workbench.view.scm'))
      const button = page.getByRole('button', { name: 'Generate Commit Message' })
      await expect(button).toBeVisible({ timeout: 15_000 })
      await button.click()

      // The streamed message should land in the commit input box.
      await expect
        .poll(() => page.evaluate(() => window.__E2E__!.getScmInputBoxValue()), {
          timeout: 30_000,
          message: 'generated commit message should be written to the input box',
        })
        .toContain(GENERATED_MESSAGE)
      await expectNoLeaks(page)
    } finally {
      await closeApp(app)
      await ollama.close()
    }
  })
})
