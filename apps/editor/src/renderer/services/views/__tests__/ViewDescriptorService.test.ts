import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  ContextKeyService,
  Emitter,
  NullLogger,
  ViewContainerLocation,
  ViewContainerRegistry,
  ViewRegistry,
  type ILoggerService,
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

const stubLoggerService = {
  createLogger: () => new NullLogger(),
} as unknown as ILoggerService

const disposables: Array<{ dispose: () => void }> = []

function registerContainer(id: string, location: ViewContainerLocation, order = 1) {
  disposables.push(
    ViewContainerRegistry.registerViewContainer({ id, label: id, icon: 'files', order, location }),
  )
}

function registerView(
  id: string,
  containerId: string,
  order = 1,
  canMoveView = true,
  when?: string,
) {
  disposables.push(
    ViewRegistry.registerView({
      id,
      name: id,
      containerId,
      componentKey: `${id}.component`,
      order,
      ...(canMoveView ? {} : { canMoveView: false }),
      ...(when !== undefined ? { when } : {}),
    }),
  )
}

function makeService(storage: IStorageService, contextKeys: ContextKeyService) {
  disposables.push(contextKeys)
  return new ViewDescriptorService(storage, hydratedWorkspace, contextKeys, stubLoggerService)
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
    const svc = makeService(service, new ContextKeyService())
    expect(svc.getViewContainerByViewId('test.v1')?.id).toBe('test.cA')
    expect(svc.getViewsByContainer('test.cA').map((v) => v.id)).toEqual(['test.v1', 'test.v2'])
    expect(svc.getViewContainerLocation('test.cA')).toBe(ViewContainerLocation.SideBar)
    svc.dispose()
  })

  it('moves a view to another container and reflects it in queries', () => {
    const { service } = makeStorage()
    const svc = makeService(service, new ContextKeyService())
    svc.moveViewsToContainer(['test.v1'], 'test.cB')
    expect(svc.getViewContainerByViewId('test.v1')?.id).toBe('test.cB')
    expect(svc.getViewsByContainer('test.cA').map((v) => v.id)).toEqual(['test.v2'])
    expect(svc.getViewsByContainer('test.cB').map((v) => v.id)).toContain('test.v1')
    svc.dispose()
  })

  it('refuses to move a view marked canMoveView: false', () => {
    registerView('test.locked', 'test.cA', 3, false)
    const { service } = makeStorage()
    const svc = makeService(service, new ContextKeyService())
    svc.moveViewsToContainer(['test.locked'], 'test.cB')
    expect(svc.getViewContainerByViewId('test.locked')?.id).toBe('test.cA')
    svc.dispose()
  })

  it('reorders views within a container', () => {
    const { service } = makeStorage()
    const svc = makeService(service, new ContextKeyService())
    svc.moveViewInContainer('test.cA', 'test.v2', 'test.v1')
    expect(svc.getViewsByContainer('test.cA').map((v) => v.id)).toEqual(['test.v2', 'test.v1'])
    svc.dispose()
  })

  it('generates a container when moving a view to a location, recycled when emptied', () => {
    const { service } = makeStorage()
    const svc = makeService(service, new ContextKeyService())
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
    const svc = makeService(service, new ContextKeyService())
    svc.moveViewContainerToLocation('test.cA', ViewContainerLocation.Panel)
    expect(svc.getViewContainerLocation('test.cA')).toBe(ViewContainerLocation.Panel)
    expect(svc.getViewContainersByLocation(ViewContainerLocation.Panel).map((c) => c.id)).toContain(
      'test.cA',
    )
    svc.dispose()
  })

  it('persists and restores collapse state and view location across a reload', async () => {
    const { service, store } = makeStorage()
    const svc = makeService(service, new ContextKeyService())
    svc.moveViewsToContainer(['test.v1'], 'test.cB')
    svc.setViewCollapsed('test.v2', true)
    await svc.save()
    svc.dispose()

    // A fresh service reading the same storage restores customizations.
    const svc2 = makeService(service, new ContextKeyService())
    await svc2.load()
    expect(svc2.getViewContainerByViewId('test.v1')?.id).toBe('test.cB')
    expect(svc2.getViewState('test.v2').collapsed).toBe(true)
    expect(store.has('workbench.viewCustomizations')).toBe(true)
    svc2.dispose()
  })

  it('setViewSizes persists only when asked (layout bookkeeping stays in memory)', async () => {
    const { service, store } = makeStorage()
    const svc = makeService(service, new ContextKeyService())

    // Default: bookkeeping only — no debounced persist even if the value
    // changed (first-layout even split, container resizes, corrections).
    svc.setViewSizes([{ id: 'test.v1', size: 200 }])
    expect(svc.getViewState('test.v1').size).toBe(200)
    await new Promise((r) => setTimeout(r, 250))
    expect(store.has('workbench.viewCustomizations')).toBe(false)

    // persist: true marks a user action and flushes even when the in-memory
    // value already matches (disk may hold nothing or an older value).
    svc.setViewSizes([{ id: 'test.v1', size: 200 }], { persist: true })
    await new Promise((r) => setTimeout(r, 250))
    const persisted = store.get('workbench.viewCustomizations') as {
      viewStates: Record<string, { size?: number }>
    }
    expect(persisted.viewStates['test.v1']?.size).toBe(200)
    svc.dispose()
  })

  it('getPersistedViewSize is immune to layout bookkeeping overwrites', async () => {
    const { service, store } = makeStorage()
    const svc = makeService(service, new ContextKeyService())

    // User sash drag-end persists the dragged sizes.
    svc.setViewSizes(
      [
        { id: 'test.v1', size: 420 },
        { id: 'test.v2', size: 300 },
      ],
      { persist: true },
    )
    expect(svc.getPersistedViewSize('test.v1')).toBe(420)

    // Layout noise (e.g. Allotment's greedy first-layout split) overwrites the
    // live bookkeeping, but never the authoritative persisted map.
    svc.setViewSizes([
      { id: 'test.v1', size: 632 },
      { id: 'test.v2', size: 88 },
    ])
    expect(svc.getViewState('test.v1').size).toBe(632)
    expect(svc.getPersistedViewSize('test.v1')).toBe(420)
    expect(svc.getPersistedViewSize('test.v2')).toBe(300)

    // An unrelated persist (collapse bumps and schedules a save) must
    // serialize the authoritative sizes, not the layout noise.
    svc.setViewCollapsed('test.v3', true)
    await new Promise((r) => setTimeout(r, 250))
    const persisted = store.get('workbench.viewCustomizations') as {
      viewStates: Record<string, { size?: number }>
    }
    expect(persisted.viewStates['test.v1']?.size).toBe(420)
    expect(persisted.viewStates['test.v2']?.size).toBe(300)
    svc.dispose()
  })

  it('reconcile rebuilds persisted sizes from storage', async () => {
    const { service, store } = makeStorage()
    store.set('workbench.viewCustomizations', {
      viewStates: { 'test.v1': { size: 420 }, 'test.v2': { size: 300, collapsed: true } },
    })
    const svc = makeService(service, new ContextKeyService())
    await svc.load()
    expect(svc.getPersistedViewSize('test.v1')).toBe(420)
    expect(svc.getPersistedViewSize('test.v2')).toBe(300)

    // Live bookkeeping may move on; the persisted value stays authoritative.
    svc.setViewSizes([{ id: 'test.v1', size: 632 }])
    expect(svc.getViewState('test.v1').size).toBe(632)
    expect(svc.getPersistedViewSize('test.v1')).toBe(420)
    svc.dispose()
  })

  it('re-registers generated containers on load', async () => {
    const { service } = makeStorage()
    const svc = makeService(service, new ContextKeyService())
    svc.moveViewToLocation('test.v3', ViewContainerLocation.SideBar)
    const genId = svc
      .getViewContainersByLocation(ViewContainerLocation.SideBar)
      .find((c) => c.id !== 'test.cA')!.id
    await svc.save()
    svc.dispose()

    const svc2 = makeService(service, new ContextKeyService())
    await svc2.load()
    expect(svc2.getViewContainerByViewId('test.v3')?.id).toBe(genId)
    expect(ViewContainerRegistry.getViewContainer(genId)).toBeDefined()
    svc2.dispose()
  })

  it('bumps version on mutation so observers re-read', () => {
    const { service } = makeStorage()
    const svc = makeService(service, new ContextKeyService())
    const before = svc.version.get()
    svc.moveViewsToContainer(['test.v1'], 'test.cB')
    expect(svc.version.get()).toBeGreaterThan(before)
    svc.dispose()
  })

  it('reset clears all customizations', async () => {
    const { service } = makeStorage()
    const svc = makeService(service, new ContextKeyService())
    svc.moveViewsToContainer(['test.v1'], 'test.cB')
    svc.reset()
    expect(svc.getViewContainerByViewId('test.v1')?.id).toBe('test.cA')
    await tick()
    svc.dispose()
  })
})

describe('ViewDescriptorService when-clause gating', () => {
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

  it('gates a when=false view out of its container queries', () => {
    registerView('test.gated', 'test.cA', 3, true, 'testGate')
    const { service } = makeStorage()
    const svc = makeService(service, new ContextKeyService())
    // Nothing ever sets testGate: it resolves false, so the view stays hidden.
    expect(svc.getViewsByContainer('test.cA').map((v) => v.id)).toEqual(['test.v1', 'test.v2'])
    // Membership (used by move/reorder bookkeeping) is unaffected by gating.
    expect(svc.getViewContainerByViewId('test.gated')?.id).toBe('test.cA')
    svc.dispose()
  })

  it('reveals and re-hides the view as its context key flips, bumping version only on change', () => {
    registerView('test.gated', 'test.cA', 3, true, 'testGate')
    const contextKeys = new ContextKeyService()
    const { service } = makeStorage()
    const svc = makeService(service, contextKeys)

    const v0 = svc.version.get()
    // An unrelated key leaves both visibility and the version observable alone.
    contextKeys.set('unrelated', true)
    expect(svc.version.get()).toBe(v0)
    expect(svc.getViewsByContainer('test.cA').map((v) => v.id)).toEqual(['test.v1', 'test.v2'])

    contextKeys.set('testGate', true)
    expect(svc.version.get()).toBeGreaterThan(v0)
    expect(svc.getViewsByContainer('test.cA').map((v) => v.id)).toEqual([
      'test.v1',
      'test.v2',
      'test.gated',
    ])

    const v1 = svc.version.get()
    contextKeys.set('testGate', false)
    expect(svc.version.get()).toBeGreaterThan(v1)
    expect(svc.getViewsByContainer('test.cA').map((v) => v.id)).toEqual(['test.v1', 'test.v2'])
    svc.dispose()
  })

  it('evaluates compound expressions key by key', () => {
    registerView('test.gated', 'test.cA', 3, true, 'testGate && testOther')
    const contextKeys = new ContextKeyService()
    const { service } = makeStorage()
    const svc = makeService(service, contextKeys)

    contextKeys.set('testGate', true)
    expect(svc.getViewsByContainer('test.cA')).toHaveLength(2)
    contextKeys.set('testOther', true)
    expect(svc.getViewsByContainer('test.cA')).toHaveLength(3)
    contextKeys.remove('testGate')
    expect(svc.getViewsByContainer('test.cA')).toHaveLength(2)
    svc.dispose()
  })

  it('drops a container left with no visible views and restores it on flip', () => {
    registerContainer('test.cC', ViewContainerLocation.SideBar, 9)
    registerView('test.onlyGated', 'test.cC', 1, true, 'testGate')
    const contextKeys = new ContextKeyService()
    const { service } = makeStorage()
    const svc = makeService(service, contextKeys)

    expect(svc.getViewContainersByLocation(ViewContainerLocation.SideBar).map((c) => c.id)).toEqual(
      ['test.cA'],
    )
    contextKeys.set('testGate', true)
    expect(svc.getViewContainersByLocation(ViewContainerLocation.SideBar).map((c) => c.id)).toEqual(
      ['test.cA', 'test.cC'],
    )
    contextKeys.set('testGate', false)
    expect(svc.getViewContainersByLocation(ViewContainerLocation.SideBar).map((c) => c.id)).toEqual(
      ['test.cA'],
    )
    svc.dispose()
  })
})
