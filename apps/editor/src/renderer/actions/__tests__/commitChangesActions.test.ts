/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Coverage for the `_workbench.showCommitChanges` bridge action: payload shape
 *  validation and the view plumbing (store update + container open + view
 *  expand), including the no-focus-stealing guarantee.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CommandsRegistry,
  ILayoutService,
  ILoggerService,
  IViewDescriptorService,
  IViewsService,
  InstantiationService,
  NullLogger,
  ServiceCollection,
  registerAction2,
  type IDisposable,
} from '@universe-editor/platform'
import type { ShowCommitChangesPayload } from '@universe-editor/extensions-common'
import { commitChangesViewState } from '../../workbench/scm/commitChanges/viewState.js'
import {
  COMMIT_CHANGES_VIEW_ID,
  FocusCommitChangesAction,
  ShowCommitChangesAction,
} from '../commitChangesActions.js'

function payload(overrides?: Partial<ShowCommitChangesPayload>): ShowCommitChangesPayload {
  return {
    providerId: 'git',
    title: 'a1b2c3d — fix crash',
    commitRef: 'a1b2c3d',
    openExternalCommand: 'git-graph.openFileDiff',
    files: [
      {
        path: 'src/a.ts',
        oldPath: null,
        status: 'M',
        resourceUri: 'file:///ws/src/a.ts',
        args: {},
      },
    ],
    ...overrides,
  }
}

describe('ShowCommitChangesAction', () => {
  const disposables: IDisposable[] = []
  let openViewContainer: ReturnType<typeof vi.fn>
  let setViewCollapsed: ReturnType<typeof vi.fn>
  let focusView: ReturnType<typeof vi.fn>
  let warn: ReturnType<typeof vi.fn>

  function setup(): void {
    disposables.push(registerAction2(ShowCommitChangesAction))
    openViewContainer = vi.fn()
    setViewCollapsed = vi.fn()
    focusView = vi.fn()
    warn = vi.fn()
  }

  async function run(arg?: unknown): Promise<void> {
    const services = new ServiceCollection()
    services.set(IViewsService, {
      _serviceBrand: undefined,
      openViewContainer,
    } as unknown as IViewsService)
    services.set(IViewDescriptorService, {
      _serviceBrand: undefined,
      setViewCollapsed,
    } as unknown as IViewDescriptorService)
    services.set(ILayoutService, {
      _serviceBrand: undefined,
      focusView,
    } as unknown as ILayoutService)
    services.set(ILoggerService, {
      _serviceBrand: undefined,
      createLogger: () => ({ ...new NullLogger(), warn, debug: vi.fn() }),
    } as unknown as ILoggerService)
    const inst = new InstantiationService(services)
    await inst.invokeFunction(async (accessor) => {
      await CommandsRegistry.getCommand(ShowCommitChangesAction.ID)!.handler(accessor, arg)
    })
  }

  afterEach(() => {
    while (disposables.length > 0) disposables.pop()?.dispose()
    commitChangesViewState._resetForTests()
    vi.clearAllMocks()
  })

  it('a valid payload updates the store, opens the SCM container and expands the view', async () => {
    setup()

    await run(payload())

    expect(commitChangesViewState.payload.get()?.commitRef).toBe('a1b2c3d')
    expect(commitChangesViewState.tick.get()).toBe(1)
    expect(openViewContainer).toHaveBeenCalledWith('workbench.view.scm')
    expect(setViewCollapsed).toHaveBeenCalledWith(COMMIT_CHANGES_VIEW_ID, false)
  })

  it('a silent payload updates the store without revealing the container or expanding the view', async () => {
    setup()

    await run(payload({ silent: true }))

    expect(commitChangesViewState.payload.get()?.commitRef).toBe('a1b2c3d')
    expect(commitChangesViewState.tick.get()).toBe(1)
    expect(openViewContainer).not.toHaveBeenCalled()
    expect(setViewCollapsed).not.toHaveBeenCalled()
  })

  it('never steals focus (focusView is not called)', async () => {
    setup()

    await run(payload())

    expect(focusView).not.toHaveBeenCalled()
  })

  it('showing twice bumps the tick even for the same commit', async () => {
    setup()

    await run(payload())
    await run(payload())

    expect(commitChangesViewState.tick.get()).toBe(2)
  })

  it('accepts optional fields when their types are correct', async () => {
    setup()

    await run(
      payload({
        subtitle: 'Jane',
        revealPath: 'src/a.ts',
        metadata: {
          author: 'Jane',
          authorDate: 1700000000,
          message: 'msg',
          parents: ['abc'],
          compareRefs: { from: 'a', to: 'b' },
        },
      }),
    )

    expect(commitChangesViewState.payload.get()?.revealPath).toBe('src/a.ts')
    expect(warn).not.toHaveBeenCalled()
  })

  it.each([
    ['undefined', undefined],
    ['a string', 'nope'],
    ['missing files', { providerId: 'git', title: 't', commitRef: 'c', openExternalCommand: 'y' }],
    ['files not an array', { ...payload(), files: 'nope' }],
    ['empty providerId', { ...payload(), providerId: '' }],
    ['missing commitRef', { ...payload(), commitRef: 42 }],
    [
      'entry oldPath not string|null',
      {
        ...payload(),
        files: [{ path: 'a', oldPath: 1, status: 'M', resourceUri: null, args: {} }],
      },
    ],
    [
      'entry missing status',
      { ...payload(), files: [{ path: 'a', oldPath: null, resourceUri: null, args: {} }] },
    ],
    ['revealPath not a string', { ...payload(), revealPath: 42 }],
    ['silent not a boolean', { ...payload(), silent: 'yes' }],
    ['subtitle not a string', { ...payload(), subtitle: 42 }],
    ['metadata.authorDate not a number', { ...payload(), metadata: { authorDate: 'now' } }],
    ['metadata.parents not strings', { ...payload(), metadata: { parents: [42] } }],
    ['metadata.compareRefs malformed', { ...payload(), metadata: { compareRefs: { from: 'a' } } }],
  ])('ignores a malformed payload (%s) with a warning', async (_label, bad) => {
    setup()

    await run(bad)

    expect(commitChangesViewState.payload.get()).toBeNull()
    expect(openViewContainer).not.toHaveBeenCalled()
    expect(setViewCollapsed).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledTimes(1)
  })
})

describe('FocusCommitChangesAction', () => {
  const disposables: IDisposable[] = []
  let openViewContainer: ReturnType<typeof vi.fn>
  let setViewCollapsed: ReturnType<typeof vi.fn>
  let focusView: ReturnType<typeof vi.fn>

  function setup(): void {
    disposables.push(registerAction2(FocusCommitChangesAction))
    openViewContainer = vi.fn()
    setViewCollapsed = vi.fn()
    focusView = vi.fn(async () => true)
  }

  async function run(): Promise<void> {
    const services = new ServiceCollection()
    services.set(IViewsService, {
      _serviceBrand: undefined,
      openViewContainer,
    } as unknown as IViewsService)
    services.set(IViewDescriptorService, {
      _serviceBrand: undefined,
      setViewCollapsed,
    } as unknown as IViewDescriptorService)
    services.set(ILayoutService, {
      _serviceBrand: undefined,
      focusView,
    } as unknown as ILayoutService)
    const inst = new InstantiationService(services)
    await inst.invokeFunction(async (accessor) => {
      await CommandsRegistry.getCommand(FocusCommitChangesAction.ID)!.handler(accessor)
    })
  }

  afterEach(() => {
    while (disposables.length > 0) disposables.pop()?.dispose()
    vi.clearAllMocks()
  })

  it('opens the SCM container, expands the view and focuses it', async () => {
    setup()

    await run()

    expect(openViewContainer).toHaveBeenCalledWith('workbench.view.scm')
    expect(setViewCollapsed).toHaveBeenCalledWith(COMMIT_CHANGES_VIEW_ID, false)
    expect(focusView).toHaveBeenCalledWith(COMMIT_CHANGES_VIEW_ID, { source: 'command' })
  })
})
