/*---------------------------------------------------------------------------------------------
 *  Shared setup for the self-launching AI extension specs: a mock Ollama backend,
 *  a userData dir pointed at it, and a git repo with one uncommitted change.
 *
 *  The aiSettings.json shape lives here and nowhere else in this package. It is a
 *  runtime JSON literal that typecheck cannot guard, and it once silently went
 *  stale in two specs at the same time when the provider model changed.
 *--------------------------------------------------------------------------------------------*/

import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { seedBaselineUserData } from '@universe-editor/e2e-harness'

export const GENERATED_MESSAGE = 'feat: add greeting'

export interface MockOllama {
  readonly url: string
  readonly close: () => Promise<void>
}

/** A minimal Ollama-compatible server: lists one model, streams a fixed reply. */
export function startMockOllama(): Promise<MockOllama> {
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

/**
 * A userData dir whose aiSettings.json points the ollama protocol at the mock.
 * `protocolMap: { ollama: [] }` means "discover from the endpoint", so the run
 * also exercises OllamaProvider.listModels → GET /api/tags. The specs leave
 * activeModels unset and let resolveModelId() fall through to the first model.
 */
export function seedAiUserData(prefix: string, ollamaUrl: string): string {
  const userDataDir = mkdtempSync(join(tmpdir(), prefix))
  seedBaselineUserData(userDataDir)
  writeFileSync(
    join(userDataDir, 'aiSettings.json'),
    JSON.stringify(
      { providers: [{ id: 'ollama', baseUrl: ollamaUrl, protocolMap: { ollama: [] } }] },
      null,
      2,
    ),
    'utf8',
  )
  return userDataDir
}

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' })
}

/** A real git repo with one uncommitted change, so there is a diff to summarize. */
export function createDirtyRepo(prefix: string): string {
  const repoDir = mkdtempSync(join(tmpdir(), prefix))
  git(repoDir, 'init')
  git(repoDir, 'config', 'user.email', 'e2e@example.com')
  git(repoDir, 'config', 'user.name', 'E2E')
  writeFileSync(join(repoDir, 'README.md'), '# hello\n', 'utf8')
  git(repoDir, 'add', '-A')
  git(repoDir, 'commit', '-m', 'init')
  writeFileSync(join(repoDir, 'README.md'), '# hello world\n', 'utf8')
  return repoDir
}
