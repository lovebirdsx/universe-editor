/*---------------------------------------------------------------------------------------------
 *  Regression (renderer OOM): opening a workspace whose Perforce changelist holds
 *  tens of thousands of files pushed one giant resourceStates array into the SCM
 *  view, which rendered every row into the DOM at once (virtualization was hard
 *  disabled via `virtualizationThreshold={Number.MAX_SAFE_INTEGER}`) — the
 *  renderer process ran out of memory (main.log: render-process-gone reason=oom).
 *
 *  The SCM tree must virtualize like the Explorer tree: above the threshold it
 *  renders only the rows in view (happy-dom has no layout engine, so
 *  @tanstack/react-virtual renders 0 visible items and only emits the spacer),
 *  NOT one <li> per resource.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
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
import { IScmService, ScmService } from '../../../services/extensions/ScmService.js'
import { ServicesContext } from '../../useService.js'

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
    executeCommand: vi.fn().mockResolvedValue(undefined),
  }
  const stubEditorResolver: IEditorResolverServiceType = {
    _serviceBrand: undefined,
    registerEditor: () => ({ dispose() {} }),
    resolveEditors: () => [],
    openEditor: vi.fn().mockResolvedValue(undefined),
  }
  const services = new ServiceCollection()
  services.set(IScmService, scm)
  services.set(ICommandService, stubCommand)
  services.set(IEditorGroupsService, {
    _serviceBrand: undefined,
    activeGroup: new (class {
      activeEditor: unknown
      indexOf(): number {
        return -1
      }
      openEditor(): void {}
      closeEditor(): void {}
    })(),
  } as unknown as IEditorGroupsServiceType)
  services.set(IStorageService, stubStorage)
  services.set(IEditorResolverService, stubEditorResolver)
  const inst = new InstantiationService(services)
  const { container } = render(
    <ServicesContext.Provider value={inst}>
      <ScmView />
    </ServicesContext.Provider>,
  )
  return { scm, container }
}

afterEach(() => cleanup())

describe('ScmView — virtualization (renderer OOM regression)', () => {
  it('does not render one DOM row per resource for a huge changelist', async () => {
    const { scm, container } = setup()

    // A changelist with far more files than any viewport can show — the shape
    // that OOMed the renderer (observed with a 70k-file changelist).
    const COUNT = 5000
    const resources = Array.from({ length: COUNT }, (_, i) => ({
      resourceUri: `D:/repo/dir${i % 50}/file${i}.txt`,
      contextValue: 'M',
    }))

    await act(async () => {
      await scm.$registerSourceControl(0, 'p4', 'Perforce', 'D:/repo')
      await scm.$registerGroup(0, 1, 'changes', 'Changes')
      await scm.$updateGroupResourceStates(1, resources)
    })

    // The group header always renders. File rows must NOT — happy-dom has no
    // layout engine so a virtualized list renders ~0 rows. Before the fix all
    // 5000 <li role="treeitem"> file rows were in the DOM.
    const rows = container.querySelectorAll('[role="treeitem"]')
    expect(rows.length).toBeLessThan(COUNT / 10)

    // The virtualized scroller mounts a spacer whose height reflects the full
    // item count (proves the rows exist in the model but are windowed, not
    // dropped). Its height is far taller than a handful of rows.
    const spacer = container.querySelector<HTMLElement>('div[style*="position: relative"]')
    expect(spacer).not.toBeNull()
    expect(parseInt(spacer!.style.height, 10)).toBeGreaterThan(COUNT * 10)
  })

  it('still renders rows inline for a small changelist (below threshold)', async () => {
    const { scm } = setup()

    await act(async () => {
      await scm.$registerSourceControl(0, 'p4', 'Perforce', 'D:/repo')
      await scm.$registerGroup(0, 1, 'changes', 'Changes')
      await scm.$updateGroupResourceStates(1, [
        { resourceUri: 'D:/repo/a.txt', contextValue: 'M' },
        { resourceUri: 'D:/repo/b.txt', contextValue: 'M' },
      ])
    })

    // Below the virtualization threshold rows render inline (no layout engine
    // needed), so their labels are queryable.
    expect(await screen.findByText('a.txt')).toBeTruthy()
    expect(await screen.findByText('b.txt')).toBeTruthy()
  })
})
