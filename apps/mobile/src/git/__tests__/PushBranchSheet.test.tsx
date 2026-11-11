import type {
  MobilePushBranchPreview,
  MobilePushBranchResult,
} from '@universe-editor/mobile-protocol'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { sessionSummary } from '../../test/protocolFixtures.js'
import { PushBranchSheet } from '../PushBranchSheet.js'

function preview(overrides: Partial<MobilePushBranchPreview> = {}): MobilePushBranchPreview {
  return {
    source: {
      worktreeName: 'feature',
      branch: 'feature',
      head: 's1abcdef',
      dirty: false,
      changedFileCount: 0,
      untrackedCount: 0,
      isMainWorktree: false,
    },
    remote: {
      name: 'origin',
      branch: 'feature',
      exists: false,
      ahead: 0,
      behind: 0,
    },
    blockers: [],
    warnings: [],
    expectation: {
      branch: 'feature',
      head: 's1abcdef',
      remote: 'origin',
      remoteBranch: 'feature',
    },
    ...overrides,
  }
}

function createClient(
  initial: MobilePushBranchPreview = preview(),
  result: MobilePushBranchResult = {
    branch: 'feature',
    remote: 'origin',
    remoteBranch: 'feature',
    head: 's1abcdef',
    published: true,
  },
) {
  return {
    previewPushBranch: vi.fn(async () => initial),
    pushBranch: vi.fn(async () => result),
  }
}

describe('PushBranchSheet', () => {
  it('pushes the pinned preview and reports the remote ref', async () => {
    const client = createClient()
    const onDismiss = vi.fn()
    const onNotice = vi.fn()
    render(
      <PushBranchSheet
        client={client}
        session={sessionSummary('s1', { status: 'idle' })}
        online
        onDismiss={onDismiss}
        onNotice={onNotice}
      />,
    )

    const start = screen.getByTestId('push-branch-start') as HTMLButtonElement
    await waitFor(() => expect(start.disabled).toBe(false))
    fireEvent.click(start)

    await waitFor(() =>
      expect(client.pushBranch).toHaveBeenCalledWith(expect.anything(), {
        branch: 'feature',
        head: 's1abcdef',
        remote: 'origin',
        remoteBranch: 'feature',
      }),
    )
    expect(onNotice).toHaveBeenCalledWith('已推送到 origin/feature')
    expect(onDismiss).toHaveBeenCalled()
  })

  it('drops the pinned remote head when the target branch is renamed', async () => {
    const client = createClient(
      preview({
        remote: {
          name: 'origin',
          branch: 'feature',
          exists: true,
          head: 'r1',
          ahead: 1,
          behind: 0,
        },
        expectation: {
          branch: 'feature',
          head: 's1abcdef',
          remote: 'origin',
          remoteBranch: 'feature',
          remoteHead: 'r1',
        },
      }),
    )
    render(
      <PushBranchSheet
        client={client}
        session={sessionSummary('s1', { status: 'idle' })}
        online
        onDismiss={vi.fn()}
        onNotice={vi.fn()}
      />,
    )

    const input = await screen.findByTestId('push-branch-remote-name')
    await waitFor(() => expect((input as HTMLInputElement).value).toBe('feature'))
    fireEvent.change(input, { target: { value: 'tasks/feature' } })
    const start = screen.getByTestId('push-branch-start') as HTMLButtonElement
    await waitFor(() => expect(start.disabled).toBe(false))
    fireEvent.click(start)

    await waitFor(() =>
      expect(client.pushBranch).toHaveBeenCalledWith(expect.anything(), {
        branch: 'feature',
        head: 's1abcdef',
        remote: 'origin',
        remoteBranch: 'tasks/feature',
      }),
    )
  })

  it('blocks a diverged remote and localises the blocker', async () => {
    const client = createClient(
      preview({
        remote: {
          name: 'origin',
          branch: 'feature',
          exists: true,
          head: 'r1',
          ahead: 1,
          behind: 1,
        },
        blockers: [
          {
            code: 'remote_diverged',
            message: 'The remote branch has commits you do not have.',
          },
        ],
      }),
    )
    render(
      <PushBranchSheet
        client={client}
        session={sessionSummary('s1', { status: 'idle' })}
        online
        onDismiss={vi.fn()}
        onNotice={vi.fn()}
      />,
    )

    await waitFor(() => expect(screen.getByText('暂时无法推送')).toBeTruthy())
    expect(screen.getByText('远端分支有本地没有的提交，请先在电脑上同步。')).toBeTruthy()
    expect((screen.getByTestId('push-branch-start') as HTMLButtonElement).disabled).toBe(true)
  })
})
