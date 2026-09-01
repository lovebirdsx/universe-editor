/**
 * `setVisible` is the mixed-workspace gate: while the SCM selection points at
 * another provider (a p4 client in a git+p4 folder, say) the branch + sync
 * pair must stay hidden even though refresh / repo change events keep firing.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const makeItem = () => ({
    text: '',
    tooltip: '',
    command: '',
    showProgress: undefined as string | undefined,
    show: vi.fn(),
    hide: vi.fn(),
    dispose: vi.fn(),
  })
  return {
    branchItem: makeItem(),
    syncItem: makeItem(),
  }
})

vi.mock('@universe-editor/extension-api', () => ({
  StatusBarAlignment: { Left: 1 },
  window: {
    createStatusBarItem: vi.fn((_alignment: unknown, priority: number) =>
      priority === 100 ? mocks.branchItem : mocks.syncItem,
    ),
  },
}))

const { GitStatusBarController } = await import('../gitStatusBar.js')

function makeRepo(overrides: Record<string, unknown> = {}): unknown {
  return {
    status: { branch: 'main', ahead: 0, behind: 0, busy: undefined, ...overrides },
    onDidChange: vi.fn(() => ({ dispose: vi.fn() })),
  }
}

function resetItems(): void {
  for (const item of [mocks.branchItem, mocks.syncItem]) {
    item.text = ''
    item.tooltip = ''
    item.command = ''
    item.showProgress = undefined
    item.show.mockClear()
    item.hide.mockClear()
  }
}

describe('GitStatusBarController', () => {
  beforeEach(resetItems)

  it('renders the branch item for the active repo', () => {
    const controller = new GitStatusBarController({
      active: makeRepo({ branch: 'feature' }),
    } as never)
    controller.refresh()

    expect(mocks.branchItem.text).toBe('$(git-branch) feature')
    expect(mocks.branchItem.show).toHaveBeenCalled()
    controller.dispose()
  })

  it('hides the sync item when there is nothing to sync', () => {
    const controller = new GitStatusBarController({ active: makeRepo() } as never)
    controller.refresh()

    expect(mocks.syncItem.hide).toHaveBeenCalled()
    expect(mocks.syncItem.show).not.toHaveBeenCalled()
    controller.dispose()
  })

  it('hides both items when there is no active repo', () => {
    const controller = new GitStatusBarController({ active: undefined } as never)
    controller.refresh()

    expect(mocks.branchItem.hide).toHaveBeenCalled()
    expect(mocks.branchItem.show).not.toHaveBeenCalled()
    controller.dispose()
  })

  it('setVisible(false) hides both items and refresh keeps them hidden', () => {
    const controller = new GitStatusBarController({ active: makeRepo() } as never)
    controller.setVisible(false)

    expect(mocks.branchItem.hide).toHaveBeenCalled()
    expect(mocks.syncItem.hide).toHaveBeenCalled()

    mocks.branchItem.show.mockClear()
    controller.refresh()
    expect(mocks.branchItem.show).not.toHaveBeenCalled()
    expect(mocks.syncItem.show).not.toHaveBeenCalled()
    controller.dispose()
  })

  it('repo change events do not re-show the items while hidden', () => {
    let listener: (() => void) | undefined
    const repo = makeRepo()
    const controller = new GitStatusBarController({
      active: {
        ...(repo as object),
        onDidChange: vi.fn((l: () => void) => {
          listener = l
          return { dispose: vi.fn() }
        }),
      },
    } as never)
    controller.refresh()
    controller.setVisible(false)
    mocks.branchItem.show.mockClear()

    listener?.()
    expect(mocks.branchItem.show).not.toHaveBeenCalled()
    expect(mocks.syncItem.show).not.toHaveBeenCalled()
    controller.dispose()
  })

  it('setVisible(true) restores and re-renders from the active repo', () => {
    const controller = new GitStatusBarController({
      active: makeRepo({ branch: 'feature', ahead: 2 }),
    } as never)
    controller.setVisible(false)
    mocks.branchItem.show.mockClear()
    mocks.syncItem.show.mockClear()

    controller.setVisible(true)
    expect(mocks.branchItem.show).toHaveBeenCalled()
    expect(mocks.syncItem.show).toHaveBeenCalled()
    expect(mocks.syncItem.text).toBe('↑2')
    controller.dispose()
  })
})
