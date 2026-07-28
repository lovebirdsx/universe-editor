/*---------------------------------------------------------------------------------------------
 *  ScmView tree-state persistence — folding and scroll position survive the
 *  provider view being unmounted (container switch / repo switch / reload).
 *
 *  The storage stub really reads and writes an in-memory map, so the second
 *  mount goes through the same prefetch → synchronous-seed path as a real
 *  remount: the TreeModel must come up already collapsed, not flash expanded.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import {
  Event,
  ICommandService,
  IEditorGroupsService,
  IEditorResolverService,
  IStorageService,
  InstantiationService,
  ServiceCollection,
  type ICommandService as ICommandServiceType,
  type IEditorGroupsService as IEditorGroupsServiceType,
  type IEditorResolverService as IEditorResolverServiceType,
  type IStorageService as IStorageServiceType,
} from '@universe-editor/platform'
import { ScmView } from '../ScmView.js'
import { _resetScmTreeStateForTests } from '../scmTreeState.js'
import { IScmService, ScmService } from '../../../services/extensions/ScmService.js'
import { ServicesContext } from '../../useService.js'

function makeStorage() {
  const data = new Map<string, unknown>()
  const stub: IStorageServiceType = {
    _serviceBrand: undefined,
    async get<T>(key: string): Promise<T | undefined> {
      return data.get(key) as T | undefined
    },
    async set(key: string, value: unknown) {
      data.set(key, value)
    },
    async remove(key: string) {
      data.delete(key)
    },
    onDidChangeWorkspaceScope: Event.None,
  }
  return { stub, data }
}

function setup(storage: IStorageServiceType) {
  const scm = new ScmService()
  const stubCommand: ICommandServiceType = {
    _serviceBrand: undefined,
    executeCommand: () => Promise.resolve(undefined),
  }
  const stubEditorResolver: IEditorResolverServiceType = {
    _serviceBrand: undefined,
    registerEditor: () => ({ dispose() {} }),
    resolveEditors: () => [],
    openEditor: () => Promise.resolve(undefined),
  }
  const services = new ServiceCollection()
  services.set(IScmService, scm)
  services.set(ICommandService, stubCommand)
  services.set(IEditorGroupsService, {
    _serviceBrand: undefined,
    activeGroup: { activeEditor: undefined },
  } as unknown as IEditorGroupsServiceType)
  services.set(IStorageService, storage)
  services.set(IEditorResolverService, stubEditorResolver)
  const inst = new InstantiationService(services)
  const view = render(
    <ServicesContext.Provider value={inst}>
      <ScmView />
    </ServicesContext.Provider>,
  )
  return { scm, view }
}

async function seedGitRepo(scm: ScmService): Promise<void> {
  await act(async () => {
    await scm.$registerSourceControl(0, 'git', 'Git', 'D:/repo')
    await scm.$registerGroup(0, 1, 'changes', 'Changes')
    await scm.$updateGroupResourceStates(1, [{ resourceUri: 'D:/repo/foo.txt', contextValue: 'M' }])
  })
}

async function flushDebounce(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 400))
  })
}

beforeEach(() => _resetScmTreeStateForTests())
afterEach(() => {
  cleanup()
  _resetScmTreeStateForTests()
})

describe('ScmView — tree state persistence', () => {
  it('keeps a collapsed group collapsed across an unmount/remount cycle', async () => {
    const { stub, data } = makeStorage()
    const first = setup(stub)
    await seedGitRepo(first.scm)

    const row = (await screen.findByText('Changes')).closest('[role="treeitem"]') as HTMLElement
    expect(row.getAttribute('aria-expanded')).toBe('true')

    // Collapse the group and let the debounced write land.
    fireEvent.click(row)
    expect(row.getAttribute('aria-expanded')).toBe('false')
    await flushDebounce()
    expect(data.get('scm/treeState/D:/repo')).toMatchObject({
      collapsedIds: expect.arrayContaining(['group:changes']),
    })

    first.view.unmount()

    // Remount against the same storage: the row must come up collapsed.
    const second = setup(stub)
    await seedGitRepo(second.scm)
    const restored = (await screen.findByText('Changes')).closest(
      '[role="treeitem"]',
    ) as HTMLElement
    expect(restored.getAttribute('aria-expanded')).toBe('false')
    // The collapsed group hides its files from the tree.
    expect(screen.queryByText('foo.txt')).toBeNull()
  })

  it('persists the scroll position on unmount and restores it on remount', async () => {
    const { stub, data } = makeStorage()
    const first = setup(stub)
    await seedGitRepo(first.scm)
    await screen.findByText('foo.txt')

    const scroller = first.view.container.querySelector<HTMLElement>('[role="tree"]')!
    scroller.scrollTop = 96
    first.view.unmount()

    expect(data.get('scm/treeState/D:/repo')).toMatchObject({ scrollTop: 96 })

    const second = setup(stub)
    await seedGitRepo(second.scm)
    await screen.findByText('foo.txt')
    const restoredScroller = second.view.container.querySelector<HTMLElement>('[role="tree"]')!
    expect(restoredScroller.scrollTop).toBe(96)
  })

  it('starts expanded when nothing was persisted for the repo', async () => {
    const { stub } = makeStorage()
    const { scm } = setup(stub)
    await seedGitRepo(scm)

    const row = (await screen.findByText('Changes')).closest('[role="treeitem"]') as HTMLElement
    expect(row.getAttribute('aria-expanded')).toBe('true')
    expect(await screen.findByText('foo.txt')).toBeTruthy()
  })
})
