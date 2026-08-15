/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Tests for RemoteAgentConfigService.codexMatchActiveApiKey — the remote host's
 *  active codex API key is matched against the editor's candidate keys, and only
 *  the index travels back (never the auth.json secrets).
 *--------------------------------------------------------------------------------------------*/

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { RemoteAgentConfigService } from '../agentConfigService.js'

const tempRoots: string[] = []

afterEach(async () => {
  await Promise.all(
    tempRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })),
  )
})

async function makeService(): Promise<{ svc: RemoteAgentConfigService; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'ue-agent-config-'))
  tempRoots.push(dir)
  const svc = new RemoteAgentConfigService(undefined, {
    codexConfigPath: join(dir, 'config.toml'),
  })
  return { svc, dir }
}

describe('RemoteAgentConfigService.codexMatchActiveApiKey', () => {
  it('returns the matching candidate index when the active key is present', async () => {
    const { svc, dir } = await makeService()
    await writeFile(join(dir, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: 'sk-2' }), 'utf8')
    await expect(svc.codexMatchActiveApiKey(['sk-1', 'sk-2', 'sk-3'])).resolves.toBe(1)
    svc.dispose()
  })

  it('returns -1 when no candidate matches the active key', async () => {
    const { svc, dir } = await makeService()
    await writeFile(join(dir, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: 'sk-other' }), 'utf8')
    await expect(svc.codexMatchActiveApiKey(['sk-1', 'sk-2'])).resolves.toBe(-1)
    svc.dispose()
  })

  it('returns -1 for a chatgpt-mode auth.json', async () => {
    const { svc, dir } = await makeService()
    await writeFile(
      join(dir, 'auth.json'),
      JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'at' } }),
      'utf8',
    )
    await expect(svc.codexMatchActiveApiKey(['sk-1'])).resolves.toBe(-1)
    svc.dispose()
  })

  it('returns -1 when auth.json is absent', async () => {
    const { svc } = await makeService()
    await expect(svc.codexMatchActiveApiKey(['sk-1'])).resolves.toBe(-1)
    svc.dispose()
  })
})
