/*---------------------------------------------------------------------------------------------
 *  Tests for WorkspaceExplorerRevealContribution
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import {
  Emitter,
  ILayoutService,
  IViewsService,
  IWorkspaceService,
  InstantiationService,
  PartId,
  ServiceCollection,
  URI,
  observableValue,
  type IRecentWorkspace,
  type IWorkspace,
  type IWorkspaceService as IWorkspaceServiceType,
} from '@universe-editor/platform'
import { WorkspaceExplorerRevealContribution } from '../WorkspaceExplorerRevealContribution.js'

function makeWorkspaceStub(initial: IWorkspace | null = null): IWorkspaceServiceType & {
  fireWorkspaceChange(workspace: IWorkspace | null): void
} {
  const wsEmitter = new Emitter<IWorkspace | null>()
  const recentEmitter = new Emitter<readonly IRecentWorkspace[]>()
  let current = initial
  return {
    _serviceBrand: undefined,
    get current() {
      return current
    },
    onDidChangeWorkspace: wsEmitter.event,
    get recent() {
      return []
    },
    onDidChangeRecent: recentEmitter.event,
    whenReady: Promise.resolve(),
    async openFolder() {},
    async closeFolder() {
      current = null
    },
    async clearRecent() {},
    async removeRecent() {},
    fireWorkspaceChange(workspace: IWorkspace | null) {
      current = workspace
      wsEmitter.fire(workspace)
    },
  }
}

function makeLayoutStub(): {
  service: (typeof ILayoutService)['prototype']
  setVisibleCalls: Array<{ part: PartId; visible: boolean }>
} {
  const setVisibleCalls: Array<{ part: PartId; visible: boolean }> = []
  const vis: Record<string, boolean> = { [PartId.SideBar]: false }
  const service = {
    _serviceBrand: undefined,
    visible: observableValue('layout.visible', vis as unknown as Readonly<Record<PartId, boolean>>),
    sizes: observableValue('layout.sizes', { sidebar: 240, secondarySidebar: 300, panel: 200 }),
    getVisible: (part: PartId) => vis[part] ?? false,
    setVisible: (part: PartId, visible: boolean) => {
      setVisibleCalls.push({ part, visible })
      vis[part] = visible
    },
    toggleVisible: () => {},
    setSize: () => {},
    async load() {},
    async save() {},
    registerPart: () => ({ dispose: () => {} }),
    getPart: () => undefined,
    getParts: () => [],
    onDidRegisterPart: new Emitter<never>().event,
  } as unknown as (typeof ILayoutService)['prototype']
  return { service, setVisibleCalls }
}

function makeViewsStub(activeId?: string): {
  service: (typeof IViewsService)['prototype']
  openContainerCalls: string[]
} {
  const openContainerCalls: string[] = []
  let active = activeId
  const service = {
    _serviceBrand: undefined,
    activeContainerByLocation: observableValue(
      'views.active',
      {} as Readonly<Record<number, string | undefined>>,
    ),
    openViewContainer: (id: string) => {
      active = id
      openContainerCalls.push(id)
    },
    closeViewContainer: () => {},
    getActiveViewContainerId: () => active,
  } as unknown as (typeof IViewsService)['prototype']
  return { service, openContainerCalls }
}

function makeContribution(
  ws: IWorkspaceServiceType,
  layout: (typeof ILayoutService)['prototype'],
  views: (typeof IViewsService)['prototype'],
): WorkspaceExplorerRevealContribution {
  const services = new ServiceCollection()
  services.set(IWorkspaceService, ws)
  services.set(ILayoutService, layout)
  services.set(IViewsService, views)
  const inst = new InstantiationService(services)
  return inst.createInstance(WorkspaceExplorerRevealContribution)
}

describe('WorkspaceExplorerRevealContribution', () => {
  it('reveals Explorer when a workspace folder is opened', () => {
    const ws = makeWorkspaceStub()
    const { service: layout, setVisibleCalls } = makeLayoutStub()
    const { service: views, openContainerCalls } = makeViewsStub()
    const contribution = makeContribution(ws, layout, views)

    ws.fireWorkspaceChange({ folder: URI.file('/tmp/myProject'), name: 'myProject' })

    expect(setVisibleCalls).toContainEqual({ part: PartId.SideBar, visible: true })
    expect(openContainerCalls).toContain('workbench.view.explorer')

    contribution.dispose()
  })

  it('does nothing when workspace is closed (null)', () => {
    const ws = makeWorkspaceStub({ folder: URI.file('/tmp/a'), name: 'a' })
    const { service: layout, setVisibleCalls } = makeLayoutStub()
    const { service: views, openContainerCalls } = makeViewsStub()
    const contribution = makeContribution(ws, layout, views)

    ws.fireWorkspaceChange(null)

    expect(setVisibleCalls).toHaveLength(0)
    expect(openContainerCalls).toHaveLength(0)

    contribution.dispose()
  })

  it('reveals Explorer for each subsequent workspace change', () => {
    const ws = makeWorkspaceStub()
    const { service: layout, setVisibleCalls } = makeLayoutStub()
    const { service: views, openContainerCalls } = makeViewsStub()
    const contribution = makeContribution(ws, layout, views)

    ws.fireWorkspaceChange({ folder: URI.file('/tmp/a'), name: 'a' })
    ws.fireWorkspaceChange({ folder: URI.file('/tmp/b'), name: 'b' })

    expect(setVisibleCalls).toHaveLength(2)
    expect(openContainerCalls).toHaveLength(2)

    contribution.dispose()
  })

  it('preserves a non-Explorer container the user already activated', () => {
    // Regression: opening a folder fires onDidChangeWorkspace asynchronously; if
    // the user has already switched the side bar to Search (e.g. clicked it right
    // after opening the folder), the late-arriving reveal must NOT clobber it.
    const ws = makeWorkspaceStub()
    const { service: layout, setVisibleCalls } = makeLayoutStub()
    const { service: views, openContainerCalls } = makeViewsStub('workbench.view.search')
    const contribution = makeContribution(ws, layout, views)

    ws.fireWorkspaceChange({ folder: URI.file('/tmp/myProject'), name: 'myProject' })

    expect(openContainerCalls).toHaveLength(0)
    expect(setVisibleCalls).toHaveLength(0)

    contribution.dispose()
  })

  it('reveals Explorer when the side bar has no active container yet', () => {
    const ws = makeWorkspaceStub()
    const { service: layout } = makeLayoutStub()
    const { service: views, openContainerCalls } = makeViewsStub(undefined)
    const contribution = makeContribution(ws, layout, views)

    ws.fireWorkspaceChange({ folder: URI.file('/tmp/myProject'), name: 'myProject' })

    expect(openContainerCalls).toContain('workbench.view.explorer')

    contribution.dispose()
  })
})
