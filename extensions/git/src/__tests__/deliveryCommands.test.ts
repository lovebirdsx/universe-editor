import { execFile } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { mkTempDir, removeDirWithRetry } from '@universe-editor/temp-root'
import { deliveryLockDir } from '../delivery/deliveryLock.js'
import { registerDeliveryCommands } from '../delivery/deliveryCommands.js'

const execFileAsync = promisify(execFile)
const tmpRoots: string[] = []

afterEach(() => {
  while (tmpRoots.length > 0) {
    const root = tmpRoots.pop()
    if (root !== undefined) removeDirWithRetry(root)
  }
})

const handlers = (): Map<string, (...args: unknown[]) => unknown> => {
  const map = new Map<string, (...args: unknown[]) => unknown>()
  registerDeliveryCommands((id, handler) => {
    map.set(id, handler)
    return { dispose: () => undefined }
  })
  return map
}

const createRepo = async (): Promise<string> => {
  const root = mkTempDir('ue-git-delivery-commands-')
  tmpRoots.push(root)
  await execFileAsync('git', ['init', '--initial-branch=main', root])
  return root
}

describe('delivery command registration', () => {
  it('registers the pending-work probe', () => {
    expect(handlers().has('git.agentDelivery.hasPendingWork')).toBe(true)
  })

  it('turns a thrown handler into a git_failed result', async () => {
    // `undefined` makes preparePickDelivery throw on its first property read;
    // the proxy must receive a result instead of a rejected promise.
    const result = await handlers().get('git.agentDelivery.preparePick')?.(undefined)

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'git_failed',
        message: "git delivery command 'preparePick' failed",
        detail: expect.any(String),
      },
    })
  })

  it('reports an inactive lock for a clean repository', async () => {
    const repo = await createRepo()
    const result = await handlers().get('git.agentDelivery.probeLock')?.({ cwd: repo })

    expect(result).toMatchObject({ ok: true, active: false })
  })

  it('reports an active foreign lock without exposing its token', async () => {
    const repo = await createRepo()
    const commonDir = join(repo, '.git')
    await mkdir(deliveryLockDir(commonDir), { recursive: true })
    await writeFile(
      join(deliveryLockDir(commonDir), 'owner.json'),
      JSON.stringify({
        token: 'secret-token',
        pid: 4242,
        hostname: 'DESKTOP-TEST',
        startedAt: new Date(0).toISOString(),
        heartbeatAt: new Date().toISOString(),
        label: 'cli 4242',
      }),
    )

    const result = await handlers().get('git.agentDelivery.probeLock')?.({ cwd: repo })

    expect(result).toMatchObject({
      ok: true,
      active: true,
      owner: { pid: 4242, hostname: 'DESKTOP-TEST', label: 'cli 4242' },
    })
    expect(JSON.stringify(result)).not.toContain('secret-token')
  })

  it('does not report the caller as busy when the lock belongs to it', async () => {
    const repo = await createRepo()
    const commonDir = join(repo, '.git')
    await mkdir(deliveryLockDir(commonDir), { recursive: true })
    await writeFile(
      join(deliveryLockDir(commonDir), 'owner.json'),
      JSON.stringify({
        token: 'own-token',
        pid: process.pid,
        hostname: hostname(),
        startedAt: new Date(0).toISOString(),
        heartbeatAt: new Date().toISOString(),
      }),
    )

    const result = await handlers().get('git.agentDelivery.probeLock')?.({
      cwd: repo,
      ownTokens: ['own-token'],
    })

    expect(result).toMatchObject({ ok: true, active: false })
  })

  it('rejects a cwd outside a repository', async () => {
    const root = mkTempDir('ue-git-delivery-commands-')
    tmpRoots.push(root)
    const result = await handlers().get('git.agentDelivery.probeLock')?.({ cwd: root })

    expect(result).toMatchObject({ ok: false, error: { code: 'not_a_repository' } })
  })
})
