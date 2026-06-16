import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  Emitter,
  ViewContainerLocation,
  ViewContainerRegistry,
  ViewRegistry,
  type IStorageService,
  type IWorkspaceService,
} from '@universe-editor/platform'
import { ViewDescriptorService } from '../ViewDescriptorService.js'

function makeStorage(initial?: Record<string, unknown>): {
  service: IStorageService
  store: Map<string, unknown>
  fireScope: () => void
} {
  const store = new Map<string, unknown>(Object.entries(initial ?? {}))
  const scope = new Emitter<void>()
  const service: IStorageService = {
    _serviceBrand: undefined,
    get: async <T>(key: string) => store.get(key) as T | undefined,
    set: async (key: string, value: unknown) => {
      store.set(key, value)
    },
    remove: async (key: string) => {
      store.delete(key)
    },
    onDidChangeWorkspaceScope: scope.event,
  }
  return { service, store, fireScope: () => scope.fire() }
}

const hydratedWorkspace = { current: {} } as unknown as IWorkspaceService

const disposables: Array<{ dispose: () => void }> = []

function registerContainer(id: string, location: ViewContainerLocation, order = 1) {
  disposables.push(
    ViewContainerRegistry.registerViewContainer({ id, label: id, icon: 'files', order, location }),
  )
}

function registerView(id: string, containerId: string, order = 1, canMoveView = true) {
  disposables.push(
    ViewRegistry.registerView({
      id,
      name: id,
      containerId,
      componentKey: `${id}.component`,
      order,
      ...(canMoveView ? {} : { canMoveView: false }),
    }),
  )
}

const tick = () => new Promise((r) => setTimeout(r, 0))

describe('ViewDescriptorService', () => {
  beforeEach(() => {
    registerContainer('test.cA', ViewContainerLocation.SideBar, 1)
    registerContainer('test.cB', ViewContainerLocation.Panel, 2)
    registerView('test.v1', 'test.cA', 1)
    registerView('test.v2', 'test.cA', 2)
    registerView('test.v3', 'test.cB', 1)
  })

  afterEach(() => {
    while (disposables.length) disposables.pop()?.dispose()
  })

  it('resolves default container and location from the registry', () => {
    const { service } = makeStorage()
    const svc = new ViewDescriptorService(service, hydratedWorkspace)
    expect(svc.getViewContainerByViewId('test.v1')?.id).toBe('test.cA')
    expect(svc.getViewsByContainer('test.cA').map((v) => v.id)).toEqual(['test.v1', 'test.v2'])
    expect(svc.getViewContainerLocation('test.cA')).toBe(ViewContainerLocation.SideBar)
    svc.dispose()
  })

  it('moves a view to another container and reflects it in queries', () => {
    const { service } = makeStorage()
    const svc = new ViewDescriptorService(service, hydratedWorkspace)
    svc.moveViewsToContainer(['test.v1'], 'test.cB')
    expect(svc.getViewContainerByViewId('test.v1')?.id).toBe('test.cB')
    expect(svc.getViewsByContainer('test.cA').map((v) => v.id)).toEqual(['test.v2'])
    expect(svc.getViewsByContainer('test.cB').map((v) => v.id)).toContain('test.v1')
    svc.dispose()
  })

  it('refuses to move a view marked canMoveView: false', () => {
    registerView('test.locked', 'test.cA', 3, false)
    const { service } = makeStorage()
    const svc = new ViewDescriptorService(service, hydratedWorkspace)
    svc.moveViewsToContainer(['test.locked'], 'test.cB')
    expect(svc.getViewContainerByViewId('test.locked')?.id).toBe('test.cA')
    svc.dispose()
  })

  it('reorders views within a container', () => {
    const { service } = makeStorage()
    const svc = new ViewDescriptorService(service, hydratedWorkspace)
    svc.moveViewInContainer('test.cA', 'test.v2', 'test.v1')
    expect(svc.getViewsByContainer('test.cA').map((v) => v.id)).toEqual(['test.v2', 'test.v1'])
    svc.dispose()
  })

  it('generates a container when moving a view to a location, recycled when emptied', () => {
    const { service } = makeStorage()
    const svc = new ViewDescriptorService(service, hydratedWorkspace)
    svc.moveViewToLocation('test.v1', ViewContainerLocation.SecondarySideBar)

    const generated = svc.getViewContainersByLocation(ViewContainerLocation.SecondarySideBar)
    expect(generated).toHaveLength(1)
    const genId = generated[0]!.id
    expect(svc.getViewContainerByViewId('test.v1')?.id).toBe(genId)

    // Moving the only view away empties the generated container → it recycles.
    svc.moveViewsToContainer(['test.v1'], 'test.cA')
    expect(svc.getViewContainersByLocation(ViewContainerLocation.SecondarySideBar)).toHaveLength(0)
    expect(ViewContainerRegistry.getViewContainer(genId)).toBeUndefined()
    svc.dispose()
  })

  it('moves a whole container to another location', () => {
    const { service } = makeStorage()
    const svc = new ViewDescriptorService(service, hydratedWorkspace)
    svc.moveViewContainerToLocation('test.cA', ViewContainerLocation.Panel)
    expect(svc.getViewContainerLocation('test.cA')).toBe(ViewContainerLocation.Panel)
    expect(svc.getViewContainersByLocation(ViewContainerLocation.Panel).map((c) => c.id)).toContain(
      'test.cA',
    )
    svc.dispose()
  })

  it('persists and restores collapse state and view location across a reload', async () => {
    const { service, store } = makeStorage()
    const svc = new ViewDescriptorService(service, hydratedWorkspace)
    svc.moveViewsToContainer(['test.v1'], 'test.cB')
    svc.setViewCollapsed('test.v2', true)
    await svc.save()
    svc.dispose()

    // A fresh service reading the same storage restores customizations.
    const svc2 = new ViewDescriptorService(service, hydratedWorkspace)
    await svc2.load()
    expect(svc2.getViewContainerByViewId('test.v1')?.id).toBe('test.cB')
    expect(svc2.getViewState('test.v2').collapsed).toBe(true)
    expect(store.has('workbench.viewCustomizations')).toBe(true)
    svc2.dispose()
  })

  it('re-registers generated containers on load', async () => {
    const { service } = makeStorage()
    const svc = new ViewDescriptorService(service, hydratedWorkspace)
    svc.moveViewToLocation('test.v3', ViewContainerLocation.SideBar)
    const genId = svc
      .getViewContainersByLocation(ViewContainerLocation.SideBar)
      .find((c) => c.id !== 'test.cA')!.id
    await svc.save()
    svc.dispose()

    const svc2 = new ViewDescriptorService(service, hydratedWorkspace)
    await svc2.load()
    expect(svc2.getViewContainerByViewId('test.v3')?.id).toBe(genId)
    expect(ViewContainerRegistry.getViewContainer(genId)).toBeDefined()
    svc2.dispose()
  })

  it('bumps version on mutation so observers re-read', () => {
    const { service } = makeStorage()
    const svc = new ViewDescriptorService(service, hydratedWorkspace)
    const before = svc.version.get()
    svc.moveViewsToContainer(['test.v1'], 'test.cB')
    expect(svc.version.get()).toBeGreaterThan(before)
    svc.dispose()
  })

  it('reset clears all customizations', async () => {
    const { service } = makeStorage()
    const svc = new ViewDescriptorService(service, hydratedWorkspace)
    svc.moveViewsToContainer(['test.v1'], 'test.cB')
    svc.reset()
    expect(svc.getViewContainerByViewId('test.v1')?.id).toBe('test.cA')
    await tick()
    svc.dispose()
  })
})
