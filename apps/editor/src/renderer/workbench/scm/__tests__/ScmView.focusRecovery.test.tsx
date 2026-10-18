/*---------------------------------------------------------------------------------------------
 *  Regression: a file row that disappears from the SCM snapshot (discard,
 *  commit, or a group change) must not leave the tree cursor dangling. The next
 *  ArrowDown used to read the missing id as "nothing focused" and jump to the
 *  first row. Staging also changes the row id (it embeds the group id), so the
 *  cursor must follow the same resource across groups.
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

const ROOT = 'D:/repo'
const A = `${ROOT}/a.txt`
const B = `${ROOT}/b.txt`
const C = `${ROOT}/c.txt`

const stubStorage: IStorageServiceType = {
  _serviceBrand: undefined,
  async get() {
    return undefined
  },
  async set() {},
  async remove() {},
  onDidChangeWorkspaceScope: Event.None,
}

function setup() {
  const scm = new ScmService()
  const stubCommand: ICommandServiceType = {
    _serviceBrand: undefined,
    executeCommand: () => Promise.resolve(undefined),
  }
  const services = new ServiceCollection()
  services.set(IScmService, scm)
  services.set(ICommandService, stubCommand)
  services.set(IEditorGroupsService, {
    _serviceBrand: undefined,
    activeGroup: { activeEditor: undefined },
  } as unknown as IEditorGroupsServiceType)
  services.set(IStorageService, stubStorage)
  services.set(IEditorResolverService, {
    _serviceBrand: undefined,
    registerEditor: () => ({ dispose() {} }),
    resolveEditors: () => [],
    openEditor: () => Promise.resolve(undefined),
  } as unknown as IEditorResolverServiceType)
  const inst = new InstantiationService(services)
  render(
    <ServicesContext.Provider value={inst}>
      <ScmView />
    </ServicesContext.Provider>,
  )
  return { scm }
}

async function seedRepository(scm: ScmService): Promise<void> {
  await act(async () => {
    await scm.$registerSourceControl(0, 'git', 'Git', ROOT)
    await scm.$registerGroup(0, 1, 'changes', 'Changes')
    await scm.$registerGroup(0, 2, 'index', 'Staged Changes')
    // An empty staging group would otherwise sit after the last file and take
    // the deleted row's slot, hiding the previous-row fallback under test.
    await scm.$updateGroup(2, { hideWhenEmpty: true })
    await scm.$updateGroupResourceStates(1, [
      { resourceUri: A, contextValue: 'M' },
      { resourceUri: B, contextValue: 'M' },
      { resourceUri: C, contextValue: 'M' },
    ])
  })
}

async function updateStates(
  scm: ScmService,
  groupHandle: number,
  resources: readonly string[],
): Promise<void> {
  await act(async () => {
    await scm.$updateGroupResourceStates(
      groupHandle,
      resources.map((resourceUri) => ({ resourceUri, contextValue: 'M' })),
    )
  })
}

function rowFor(name: string): HTMLElement {
  return screen.getByText(name).closest('[role="treeitem"]') as HTMLElement
}

beforeEach(() => _resetScmTreeStateForTests())
afterEach(() => {
  cleanup()
  _resetScmTreeStateForTests()
})

describe('ScmView — focus recovery', () => {
  it('moves the cursor to the next row when the focused file leaves SCM', async () => {
    const { scm } = setup()
    await seedRepository(scm)
    await screen.findByText('b.txt')
    fireEvent.click(rowFor('b.txt'))
    expect(rowFor('b.txt').getAttribute('aria-selected')).toBe('true')

    await updateStates(scm, 1, [A, C])

    expect(screen.queryByText('b.txt')).toBeNull()
    expect(rowFor('c.txt').getAttribute('aria-selected')).toBe('true')
  })

  it('keeps the cursor on the same resource when staging moves it to another group', async () => {
    const { scm } = setup()
    await seedRepository(scm)
    await screen.findByText('b.txt')
    fireEvent.click(rowFor('b.txt'))
    expect(rowFor('b.txt').getAttribute('aria-selected')).toBe('true')

    await act(async () => {
      await scm.$updateGroupResourceStates(1, [
        { resourceUri: A, contextValue: 'M' },
        { resourceUri: C, contextValue: 'M' },
      ])
      await scm.$updateGroupResourceStates(2, [{ resourceUri: B, contextValue: 'M' }])
    })

    // The row id changed with the group, but the cursor followed the file.
    expect(rowFor('b.txt').getAttribute('aria-selected')).toBe('true')
    expect(rowFor('c.txt').getAttribute('aria-selected')).toBe('false')
  })

  it('follows the same resource when the two group updates land in separate renders', async () => {
    const { scm } = setup()
    await seedRepository(scm)
    await screen.findByText('b.txt')
    fireEvent.click(rowFor('b.txt'))

    // First the source group loses the row; recovery parks the cursor on the
    // next file while the follow is still waiting for the destination group.
    await updateStates(scm, 1, [A, C])
    expect(rowFor('c.txt').getAttribute('aria-selected')).toBe('true')

    await updateStates(scm, 2, [B])

    expect(rowFor('b.txt').getAttribute('aria-selected')).toBe('true')
    expect(rowFor('c.txt').getAttribute('aria-selected')).toBe('false')
  })

  it('moves the cursor up when the focused file was the last row', async () => {
    const { scm } = setup()
    await seedRepository(scm)
    await screen.findByText('c.txt')
    fireEvent.click(rowFor('c.txt'))
    expect(rowFor('c.txt').getAttribute('aria-selected')).toBe('true')

    await updateStates(scm, 1, [A, B])

    expect(rowFor('b.txt').getAttribute('aria-selected')).toBe('true')
  })
})
