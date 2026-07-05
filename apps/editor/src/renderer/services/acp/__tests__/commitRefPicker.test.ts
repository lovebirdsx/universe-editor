/*---------------------------------------------------------------------------------------------
 *  Tests for commitRefPicker.ts: repo resolution, the setRepo→getCommits sequencing
 *  the git-graph extension's stateful commands require, and the QuickPick lifecycle
 *  (busy toggling, item mapping, accept/hide resolution).
 *--------------------------------------------------------------------------------------------*/

import type { GitGraphCommitDto, GitGraphLoadResult } from '@universe-editor/extensions-common'
import { GitGraphCommands } from '@universe-editor/extensions-common'
import {
  Emitter,
  Severity,
  type ICommandService,
  type IInputOptions,
  type INotificationHandle,
  type INotificationService,
  type IPickOptions,
  type IQuickInputButton,
  type IQuickInputService,
  type IQuickPick,
  type IQuickPickItem,
  type QuickPickInput,
  type QuickPickPresentation,
} from '@universe-editor/platform'
import { afterEach, describe, expect, it } from 'vitest'
import { scmViewState } from '../../../workbench/scm/scmViewState.js'
import { CommitRefPicker } from '../commitRefPicker.js'

class FakeQuickPick<T extends IQuickPickItem> implements IQuickPick<T> {
  private readonly _onDidAccept = new Emitter<T[]>()
  private readonly _onDidHide = new Emitter<void>()
  private readonly _onDidChangeValue = new Emitter<string>()
  private readonly _onDidChangeActive = new Emitter<T | undefined>()
  private readonly _onDidTriggerButton = new Emitter<IQuickInputButton>()
  private readonly _onDidTriggerOk = new Emitter<void>()

  readonly onDidAccept = this._onDidAccept.event
  readonly onDidHide = this._onDidHide.event
  readonly onDidChangeValue = this._onDidChangeValue.event
  readonly onDidChangeActive = this._onDidChangeActive.event
  readonly onDidTriggerButton = this._onDidTriggerButton.event
  readonly onDidTriggerOk = this._onDidTriggerOk.event

  valueSelection: [number, number] | undefined
  activeItems: readonly T[] = []
  title: string | undefined
  buttons: readonly IQuickInputButton[] = []
  okLabel: string | undefined
  keepOpenOnAccept = false
  placeholder: string | undefined
  items: readonly QuickPickInput<T>[] = []
  value = ''
  prefix = ''
  mruIds: readonly string[] = []
  filterExternally = false
  filterMode: 'fuzzy' | 'word' = 'fuzzy'
  matchOnDescription = false
  matchOnDetail = false
  presentation: QuickPickPresentation = 'default'
  busy = false
  shown = false
  disposed = false

  show(): void {
    this.shown = true
  }

  hide(): void {
    if (!this.shown) return
    this.shown = false
    this._onDidHide.fire()
  }

  accept(item: T): void {
    this._onDidAccept.fire([item])
  }

  dispose(): void {
    this.disposed = true
    this._onDidAccept.dispose()
    this._onDidHide.dispose()
    this._onDidChangeValue.dispose()
    this._onDidChangeActive.dispose()
    this._onDidTriggerButton.dispose()
    this._onDidTriggerOk.dispose()
  }
}

class FakeQuickInputService implements IQuickInputService {
  declare readonly _serviceBrand: undefined
  picker: FakeQuickPick<IQuickPickItem> | undefined

  createQuickPick<T extends IQuickPickItem>(): IQuickPick<T> {
    const picker = new FakeQuickPick<T>()
    this.picker = picker as unknown as FakeQuickPick<IQuickPickItem>
    return picker
  }

  async pick<T extends IQuickPickItem>(
    _items: readonly QuickPickInput<T>[],
    _options?: IPickOptions,
  ): Promise<T | undefined> {
    return undefined
  }

  async input(_options?: IInputOptions): Promise<string | undefined> {
    return undefined
  }

  hide(): void {
    this.picker?.hide()
  }
}

class FakeCommandService implements ICommandService {
  declare readonly _serviceBrand: undefined
  readonly calls: Array<{ id: string; args: unknown[] }> = []
  handlers = new Map<string, (...args: unknown[]) => unknown>()

  async executeCommand<T>(id: string, ...args: unknown[]): Promise<T | undefined> {
    this.calls.push({ id, args })
    return (await this.handlers.get(id)?.(...args)) as T | undefined
  }
}

class FakeNotificationService implements INotificationService {
  declare readonly _serviceBrand: undefined
  readonly notified: Array<{ severity: Severity; message: string }> = []
  readonly notifications = { get: () => [] } as never
  readonly unreadCount = { get: () => 0 } as never
  readonly centerVisible = { get: () => false } as never

  notify(opts: { severity: Severity; message: string }): INotificationHandle {
    this.notified.push({ severity: opts.severity, message: opts.message })
    return {
      id: 'x',
      progress: { report: () => {}, done: () => {} },
      updateMessage: () => {},
      updateSeverity: () => {},
      dispose: () => {},
    }
  }

  async prompt(): Promise<void> {}
  status(): INotificationHandle {
    return this.notify({ severity: Severity.Info, message: '' })
  }
  dismiss(): void {}
  cancelProgress(): void {}
  clearAll(): void {}
  toggleCenter(): void {}
  markAllAsRead(): void {}
}

function makeScmService(sourceControls: readonly { rootUri: string | undefined }[]) {
  return { sourceControls: { get: () => sourceControls } } as never
}

function commit(over: Partial<GitGraphCommitDto> = {}): GitGraphCommitDto {
  return {
    hash: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
    parents: [],
    author: 'Alice',
    email: 'alice@example.com',
    date: 1700000000,
    message: 'fix login bug',
    heads: [],
    tags: [],
    remotes: [],
    stash: null,
    worktrees: [],
    ...over,
  }
}

afterEach(() => {
  scmViewState.setSelectedRepo(undefined)
})

describe('CommitRefPicker', () => {
  it('reports no repo and executes no commands when there is no source control', async () => {
    const commands = new FakeCommandService()
    const quickInput = new FakeQuickInputService()
    const notification = new FakeNotificationService()
    const picker = new CommitRefPicker(
      commands as never,
      quickInput as never,
      makeScmService([]),
      notification as never,
    )

    const ref = await picker.pick()

    expect(ref).toBeUndefined()
    expect(commands.calls).toEqual([])
    expect(notification.notified).toHaveLength(1)
    expect(notification.notified[0]?.severity).toBe(Severity.Warning)
  })

  it('prefers scmViewState.selectedRepo, falling back to the first source control', async () => {
    const commands = new FakeCommandService()
    commands.handlers.set(GitGraphCommands.setRepo, () => undefined)
    commands.handlers.set(
      GitGraphCommands.getCommits,
      () =>
        ({
          commits: [],
          head: null,
          headName: null,
          moreAvailable: false,
          uncommittedChanges: 0,
        }) as GitGraphLoadResult,
    )
    const quickInput = new FakeQuickInputService()
    const notification = new FakeNotificationService()
    const scm = makeScmService([{ rootUri: '/repo-a' }, { rootUri: '/repo-b' }])

    scmViewState.setSelectedRepo('/repo-b')
    const picker = new CommitRefPicker(
      commands as never,
      quickInput as never,
      scm,
      notification as never,
    )
    void picker.pick()
    await Promise.resolve()
    await Promise.resolve()

    expect(commands.calls[0]).toEqual({ id: GitGraphCommands.setRepo, args: ['/repo-b'] })

    quickInput.picker?.hide()
  })

  it('falls back to the first source control when selectedRepo is not among them', async () => {
    const commands = new FakeCommandService()
    commands.handlers.set(GitGraphCommands.setRepo, () => undefined)
    commands.handlers.set(
      GitGraphCommands.getCommits,
      () =>
        ({
          commits: [],
          head: null,
          headName: null,
          moreAvailable: false,
          uncommittedChanges: 0,
        }) as GitGraphLoadResult,
    )
    const quickInput = new FakeQuickInputService()
    const notification = new FakeNotificationService()
    const scm = makeScmService([{ rootUri: '/repo-a' }])

    scmViewState.setSelectedRepo('/stale-repo')
    const picker = new CommitRefPicker(
      commands as never,
      quickInput as never,
      scm,
      notification as never,
    )
    void picker.pick()
    await Promise.resolve()
    await Promise.resolve()

    expect(commands.calls[0]).toEqual({ id: GitGraphCommands.setRepo, args: ['/repo-a'] })

    quickInput.picker?.hide()
  })

  it('calls setRepo before getCommits with maxCommits/order/includeRemotes, toggles busy, and maps items', async () => {
    const commands = new FakeCommandService()
    commands.handlers.set(GitGraphCommands.setRepo, () => undefined)
    commands.handlers.set(
      GitGraphCommands.getCommits,
      () =>
        ({
          commits: [commit()],
          head: commit().hash,
          headName: 'main',
          moreAvailable: false,
          uncommittedChanges: 0,
        }) as GitGraphLoadResult,
    )
    const quickInput = new FakeQuickInputService()
    const notification = new FakeNotificationService()
    const scm = makeScmService([{ rootUri: '/repo-a' }])

    const picker = new CommitRefPicker(
      commands as never,
      quickInput as never,
      scm,
      notification as never,
    )
    const pending = picker.pick()

    // Let the async setRepo/getCommits chain settle before inspecting the picker.
    // The exact microtask hop count depends on how many awaits FakeCommandService
    // chains internally, so flush generously rather than counting ticks by hand.
    for (let i = 0; i < 10; i++) await Promise.resolve()

    expect(commands.calls.map((c) => c.id)).toEqual([
      GitGraphCommands.setRepo,
      GitGraphCommands.getCommits,
    ])
    expect(commands.calls[1]?.args).toEqual([
      { maxCommits: 200, order: 'date', includeRemotes: true },
    ])
    expect(quickInput.picker?.busy).toBe(false)
    expect(quickInput.picker?.items).toHaveLength(1)
    expect(quickInput.picker?.items[0]).toMatchObject({
      id: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
      label: 'a1b2c3d fix login bug',
      description: 'Alice',
    })

    quickInput.picker?.accept(quickInput.picker.items[0] as IQuickPickItem)
    const ref = await pending

    expect(ref?.kind).toBe('commit')
    expect(ref?.label).toBe('a1b2c3d fix login bug')
    expect(ref?.meta?.commitHash).toBe('a1b2c3d4e5f60718293a4b5c6d7e8f9012345678')
    expect(ref?.meta?.description).toBe('fix login bug')
  })

  it('resolves undefined and disposes the picker when the QuickPick is dismissed', async () => {
    const commands = new FakeCommandService()
    commands.handlers.set(GitGraphCommands.setRepo, () => undefined)
    commands.handlers.set(
      GitGraphCommands.getCommits,
      () =>
        ({
          commits: [],
          head: null,
          headName: null,
          moreAvailable: false,
          uncommittedChanges: 0,
        }) as GitGraphLoadResult,
    )
    const quickInput = new FakeQuickInputService()
    const notification = new FakeNotificationService()
    const scm = makeScmService([{ rootUri: '/repo-a' }])

    const picker = new CommitRefPicker(
      commands as never,
      quickInput as never,
      scm,
      notification as never,
    )
    const pending = picker.pick()
    // Must flush past the point where pick() registers its onDidHide listener,
    // otherwise hide() fires before anyone is listening and pending never settles.
    for (let i = 0; i < 10; i++) await Promise.resolve()

    quickInput.picker?.hide()
    const ref = await pending

    expect(ref).toBeUndefined()
    expect(quickInput.picker?.disposed).toBe(true)
  })

  it('notifies an error and resolves undefined when loading commits throws', async () => {
    const commands = new FakeCommandService()
    commands.handlers.set(GitGraphCommands.setRepo, () => undefined)
    commands.handlers.set(GitGraphCommands.getCommits, () => {
      throw new Error('boom')
    })
    const quickInput = new FakeQuickInputService()
    const notification = new FakeNotificationService()
    const scm = makeScmService([{ rootUri: '/repo-a' }])

    const picker = new CommitRefPicker(
      commands as never,
      quickInput as never,
      scm,
      notification as never,
    )
    const ref = await picker.pick()

    expect(ref).toBeUndefined()
    expect(notification.notified).toHaveLength(1)
    expect(notification.notified[0]?.severity).toBe(Severity.Error)
    expect(quickInput.picker?.disposed).toBe(true)
  })
})
