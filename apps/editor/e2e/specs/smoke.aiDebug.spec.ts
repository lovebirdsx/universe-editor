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

import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { APP_ROOT, MAIN_ENTRY, closeApp } from '../fixtures/electronApp.js'
import { expectNoLeaks } from '../pages/WorkbenchPO.js'

const GENERATED_MESSAGE = 'feat: add greeting'
const AI_DEBUG_CONTAINER = 'workbench.view.aiDebug'
const AI_DEBUG_VIEW = 'workbench.view.aiDebug.main'

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

test.describe('@p1 ai debug', () => {
  test('records a real AI request and replays it offline', async () => {
    test.setTimeout(120_000)
    const ollama = await startMockOllama()

    const userDataDir = mkdtempSync(join(tmpdir(), 'universe-editor-e2e-aidebug-'))
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
    writeFileSync(
      join(userDataDir, 'aiSettings.json'),
      JSON.stringify(
        { groups: [{ name: 'default', vendor: 'ollama', baseUrl: ollama.url }] },
        null,
        2,
      ),
      'utf8',
    )

    const repoDir = mkdtempSync(join(tmpdir(), 'universe-editor-e2e-aidebug-repo-'))
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
