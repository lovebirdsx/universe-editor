/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Focus target memory: returning to the SCM view restores the commit box / tree
 *  region the user left, and a remount restores the focused file row. Reveal
 *  requests still win for explicit targets; the AI bridge asks for the input.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import {
  Event,
  ICommandService,
  IEditorGroupsService,
  IEditorResolverService,
  IFocusableRegistry,
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
import { _resetScmFocusStateForTests } from '../scmFocusState.js'
import { scmViewState } from '../scmViewState.js'
import { IScmService, ScmService } from '../../../services/extensions/ScmService.js'
import { FocusableRegistry } from '../../../services/focus/FocusableRegistry.js'
import { ServicesContext } from '../../useService.js'

const VIEW_ID = 'workbench.view.scm.main'
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
  const registry = new FocusableRegistry()
  const stubCommand: ICommandServiceType = {
    _serviceBrand: undefined,
    executeCommand: () => Promise.resolve(undefined),
  }
  const services = new ServiceCollection()
  services.set(IScmService, scm)
  services.set(IFocusableRegistry, registry)
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
  const renderView = () =>
    render(
      <ServicesContext.Provider value={inst}>
        <ScmView />
      </ServicesContext.Provider>,
    )
  const view = renderView()
  return { scm, registry, inst, view, renderView }
}

async function seedRepository(scm: ScmService): Promise<void> {
  await act(async () => {
    await scm.$registerSourceControl(0, 'git', 'Git', ROOT)
    await scm.$registerGroup(0, 1, 'changes', 'Changes')
    await scm.$updateGroupResourceStates(1, [
      { resourceUri: A, contextValue: 'M' },
      { resourceUri: B, contextValue: 'M' },
      { resourceUri: C, contextValue: 'M' },
    ])
  })
}

function rowFor(name: string): HTMLElement {
  return screen.getByText(name).closest('[role="treeitem"]') as HTMLElement
}

function treeElement(): HTMLElement {
  return document.querySelector('[role="tree"]') as HTMLElement
}

function commitInput(): HTMLTextAreaElement {
  return document.querySelector('textarea') as HTMLTextAreaElement
}

function focusTarget(registry: FocusableRegistry): HTMLElement | null {
  return (registry.get(VIEW_ID)?.() ?? null) as HTMLElement | null
}

async function focusTreeRow(name: string): Promise<void> {
  fireEvent.click(rowFor(name))
  fireEvent.focusIn(treeElement())
}

beforeEach(() => {
  _resetScmTreeStateForTests()
  _resetScmFocusStateForTests()
  scmViewState._resetForTests()
})

afterEach(() => {
  cleanup()
  _resetScmTreeStateForTests()
  _resetScmFocusStateForTests()
  scmViewState._resetForTests()
})

describe('ScmView focus memory', () => {
  it('focuses the commit input by default', async () => {
    const { scm, registry } = setup()
    await seedRepository(scm)
    await screen.findByText('b.txt')

    const target = focusTarget(registry)
    expect(target?.tagName).toBe('TEXTAREA')
  })

  it('restores the tree region after the user last focused the tree', async () => {
    const { scm, registry } = setup()
    await seedRepository(scm)
    await screen.findByText('b.txt')

    await focusTreeRow('b.txt')

    expect(focusTarget(registry)).toBe(treeElement())

    fireEvent.focusIn(commitInput())
    expect(focusTarget(registry)?.tagName).toBe('TEXTAREA')
  })

  it('restores the remembered file row after an unmount/remount', async () => {
    const { scm, registry, view, renderView } = setup()
    await seedRepository(scm)
    await screen.findByText('b.txt')

    await focusTreeRow('b.txt')
    view.unmount()

    renderView()
    await screen.findByText('b.txt')

    const tree = treeElement()
    expect(focusTarget(registry)).toBe(tree)

    fireEvent.focusIn(tree)
    expect(rowFor('b.txt').getAttribute('aria-selected')).toBe('true')
    expect(rowFor('a.txt').getAttribute('aria-selected')).toBe('false')
  })

  it('a reveal request still selects and focuses its row', async () => {
    const { scm, registry } = setup()
    await seedRepository(scm)
    await screen.findByText('b.txt')

    await act(async () => {
      scmViewState.requestReveal(B)
    })

    await vi.waitFor(() => {
      expect(rowFor('b.txt').getAttribute('aria-selected')).toBe('true')
    })
    expect(focusTarget(registry)).toBe(treeElement())
  })

  it('does not replay a consumed reveal request after a remount', async () => {
    const { scm, view, renderView } = setup()
    await seedRepository(scm)
    await screen.findByText('b.txt')

    await act(async () => {
      scmViewState.requestReveal(B)
    })
    await vi.waitFor(() => {
      expect(rowFor('b.txt').getAttribute('aria-selected')).toBe('true')
    })

    // The user moves on to another row before leaving the view.
    await focusTreeRow('a.txt')
    view.unmount()

    renderView()
    await screen.findByText('a.txt')

    fireEvent.focusIn(treeElement())
    expect(rowFor('a.txt').getAttribute('aria-selected')).toBe('true')
    expect(rowFor('b.txt').getAttribute('aria-selected')).toBe('false')
  })

  it('keeps the remembered region when a reveal request matches nothing', async () => {
    const { scm, registry } = setup()
    await seedRepository(scm)
    await screen.findByText('b.txt')

    await focusTreeRow('b.txt')
    await act(async () => {
      scmViewState.requestReveal(`${ROOT}/clean.txt`)
    })

    expect(focusTarget(registry)).toBe(treeElement())
    expect(rowFor('b.txt').getAttribute('aria-selected')).toBe('true')
  })

  it('lets the AI bridge force the commit input over the tree memory', async () => {
    const { scm, registry } = setup()
    await seedRepository(scm)
    await screen.findByText('b.txt')

    await focusTreeRow('b.txt')

    await act(async () => {
      scmViewState.requestReveal(null, { focusInput: true })
    })

    expect(focusTarget(registry)?.tagName).toBe('TEXTAREA')
  })

  it('falls back to the first file row when the remembered file disappeared', async () => {
    const { scm, view, renderView } = setup()
    await seedRepository(scm)
    await screen.findByText('b.txt')

    await focusTreeRow('b.txt')
    view.unmount()

    await act(async () => {
      await scm.$updateGroupResourceStates(1, [
        { resourceUri: A, contextValue: 'M' },
        { resourceUri: C, contextValue: 'M' },
      ])
    })

    renderView()
    await screen.findByText('a.txt')

    fireEvent.focusIn(treeElement())
    expect(rowFor('a.txt').getAttribute('aria-selected')).toBe('true')
  })

  it('does not reseed a focused row that is still visible', async () => {
    const { scm } = setup()
    await seedRepository(scm)
    await screen.findByText('c.txt')

    await focusTreeRow('c.txt')
    fireEvent.focusIn(treeElement())
    fireEvent.focusIn(treeElement())

    expect(rowFor('c.txt').getAttribute('aria-selected')).toBe('true')
    expect(rowFor('a.txt').getAttribute('aria-selected')).toBe('false')
  })
})
