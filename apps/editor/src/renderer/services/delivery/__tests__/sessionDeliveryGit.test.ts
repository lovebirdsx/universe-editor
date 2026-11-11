import type { ICommandService } from '@universe-editor/platform'
import { describe, expect, it, vi } from 'vitest'
import { SessionDeliveryGit } from '../sessionDeliveryGit.js'

describe('SessionDeliveryGit', () => {
  it('reports a rejected command as git_failed with the cause in detail', async () => {
    const commands = {
      executeCommand: vi.fn(async () => {
        throw new Error('extension host disconnected')
      }),
    } as unknown as ICommandService
    const git = new SessionDeliveryGit(commands)

    const result = await git.preparePick({
      commonDir: '/repo/.git',
      deliveryId: 'delivery-1',
      token: 'token-1',
      mainWorktree: '/repo',
      sourceWorktree: '/repo/.worktrees/task1',
      baseSha: 'base-1',
      sourceHead: 'source-1',
      commits: ['commit-1'],
    })

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'git_failed',
        message: "git delivery command 'preparePick' failed",
        detail: 'extension host disconnected',
      },
    })
  })
})
