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
 *  Why Ollama and not OpenAI: the OpenAI provider needs a key, and secret storage
 *  refuses to operate when the OS keychain is unavailable (headless CI). Ollama
 *  needs no key and the generation flow is provider-agnostic (it picks the first
 *  available model), so a mock Ollama backend covers the whole chain.
 *--------------------------------------------------------------------------------------------*/

import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { APP_ROOT, MAIN_ENTRY } from '../fixtures/electronApp.js'
import { expectNoLeaks } from '../pages/WorkbenchPO.js'

const GENERATED_MESSAGE = 'feat: add greeting'

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' })
}

/** A minimal Ollama-compatible server: lists one model, streams a fixed reply. */
function startMockOllama(): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/api/tags') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ models: [{ name: 'commitbot' }] }))
      return
    }
    if (req.method === 'POST' && req.url === '/api/chat') {
      res.writeHead(200, { 'content-type': 'application/x-ndjson' })
      res.write(JSON.stringify({ message: { content: GENERATED_MESSAGE }, done: false }) + '\n')
      res.end(JSON.stringify({ done: true, prompt_eval_count: 1, eval_count: 1 }) + '\n')
      return
    }
    res.writeHead(404)
    res.end()
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>((done) => server.close(() => done())),
      })
    })
  })
}

test.describe('@p0 ai commit message generation', () => {
  test('streams the model output into the commit input box', async () => {
    // Heavier than the button-presence smoke test: it boots Electron, activates
    // the git + ai extensions, and runs a real generation. Give it headroom for
    // cold starts under parallel load.
    test.setTimeout(120_000)
    const ollama = await startMockOllama()

    const userDataDir = mkdtempSync(join(tmpdir(), 'universe-editor-e2e-aigen-'))
    writeFileSync(
      join(userDataDir, 'settings.json'),
      JSON.stringify({ 'workbench.language': 'en-US', 'update.mode': 'manual' }, null, 2),
      'utf8',
    )
    writeFileSync(
      join(userDataDir, 'state.json'),
      JSON.stringify({ 'welcome.agentOnboarding.seen': true }, null, 2),
      'utf8',
    )
    // Point the Ollama provider group at the mock server via aiSettings.json (the
    // config dir defaults to userData). commitMessage.modelId stays empty so
    // resolveModelId auto-picks the first available model.
    writeFileSync(
      join(userDataDir, 'aiSettings.json'),
      JSON.stringify(
        { groups: [{ name: 'default', vendor: 'ollama', baseUrl: ollama.url }] },
        null,
        2,
      ),
      'utf8',
    )

    // A real git repo with one uncommitted change so there is a diff to summarize.
    const repoDir = mkdtempSync(join(tmpdir(), 'universe-editor-e2e-aigen-repo-'))
    git(repoDir, 'init')
    git(repoDir, 'config', 'user.email', 'e2e@example.com')
    git(repoDir, 'config', 'user.name', 'E2E')
    writeFileSync(join(repoDir, 'README.md'), '# hello\n', 'utf8')
    git(repoDir, 'add', '-A')
    git(repoDir, 'commit', '-m', 'init')
    writeFileSync(join(repoDir, 'README.md'), '# hello world\n', 'utf8')

    const { ELECTRON_RUN_AS_NODE: _ignored, ...inheritedEnv } = process.env
    const app = await electron.launch({
      args: [MAIN_ENTRY, `--user-data-dir=${userDataDir}`],
      cwd: APP_ROOT,
      env: {
        ...inheritedEnv,
        UNIVERSE_E2E: '1',
        NODE_ENV: inheritedEnv['NODE_ENV'] ?? 'production',
      },
    })
    try {
      const page = await app.firstWindow()
      await page.waitForLoadState('domcontentloaded')
      await page.waitForFunction(() =>
        Boolean((window as unknown as Record<string, unknown>)['__E2E__']),
      )
      await page.evaluate(() => window.__E2E__!.whenRestored())

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
      await app.close()
      await ollama.close()
    }
  })
})
