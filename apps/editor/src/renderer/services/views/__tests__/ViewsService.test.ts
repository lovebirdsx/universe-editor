import { describe, it, expect, afterEach } from 'vitest'
import {
  Emitter,
  Event,
  ViewContainerLocation,
  ViewContainerRegistry,
  constObservable,
  type IStorageService,
  type IViewDescriptorService,
  type IWorkspaceService,
} from '@universe-editor/platform'
import { ViewsService } from '../ViewsService.js'

const stubStorage: IStorageService = {
  _serviceBrand: undefined,
  get: async () => undefined,
  set: async () => {},
  remove: async () => {},
  onDidChangeWorkspaceScope: Event.None,
}

// Most tests exercise synchronous in-memory selection and never call load(),
// so a hydrated workspace (current non-null) keeps load() from waiting.
const stubWorkspace = { current: {} } as unknown as IWorkspaceService

// Stub the mapping layer with the static registry defaults — these tests predate
// runtime view↔container customization and only need each container's home
// location, which the registry already records.
const stubViewDescriptors = {
  _serviceBrand: undefined,
  version: constObservable(0),
  getViewContainerLocation: (id: string) => ViewContainerRegistry.getViewContainer(id)?.location,
  getViewContainersByLocation: (location: ViewContainerLocation) =>
    ViewContainerRegistry.getViewContainers(location),
} as unknown as IViewDescriptorService

function makeService(
  storage: IStorageService = stubStorage,
  workspace: IWorkspaceService = stubWorkspace,
): ViewsService {
  return new ViewsService(storage, workspace, stubViewDescriptors)
}

describe('ViewsService', () => {
  it('openViewContainer sets the active container for the location', () => {
    const svc = makeService()
    svc.openViewContainer('explorer')
    expect(svc.getActiveViewContainerId(ViewContainerLocation.SideBar)).toBe('explorer')
  })

  it('openViewContainer replaces previously active container at the same location', () => {
    const svc = makeService()
    svc.openViewContainer('explorer')
    svc.openViewContainer('search')
    expect(svc.getActiveViewContainerId(ViewContainerLocation.SideBar)).toBe('search')
  })

  it('closeViewContainer clears active when matching, otherwise no-op', () => {
    const svc = makeService()
    svc.openViewContainer('explorer')

    svc.closeViewContainer('search') // not active, no-op
    expect(svc.getActiveViewContainerId(ViewContainerLocation.SideBar)).toBe('explorer')

    svc.closeViewContainer('explorer')
    expect(svc.getActiveViewContainerId(ViewContainerLocation.SideBar)).toBeUndefined()
  })

  describe('secondary sidebar location resolution', () => {
    let cleanup: (() => void) | undefined

    afterEach(() => {
      cleanup?.()
      cleanup = undefined
    })

    it('routes registered secondary sidebar containers to the correct location', () => {
      const disposable = ViewContainerRegistry.registerViewContainer({
        id: 'test.outline',
        label: 'Outline',
        icon: 'search',
        order: 1,
        location: ViewContainerLocation.SecondarySideBar,
      })
      cleanup = () => disposable.dispose()

      const svc = makeService()
      svc.openViewContainer('test.outline')

      expect(svc.getActiveViewContainerId(ViewContainerLocation.SecondarySideBar)).toBe(
        'test.outline',
      )
      expect(svc.getActiveViewContainerId(ViewContainerLocation.SideBar)).toBeUndefined()
    })

    it('primary and secondary sidebar containers are independent', () => {
      const d = ViewContainerRegistry.registerViewContainer({
        id: 'test.outline2',
        label: 'Outline',
        icon: 'search',
        order: 1,
        location: ViewContainerLocation.SecondarySideBar,
      })
      cleanup = () => d.dispose()

      const svc = makeService()
      svc.openViewContainer('explorer')
      svc.openViewContainer('test.outline2')

      expect(svc.getActiveViewContainerId(ViewContainerLocation.SideBar)).toBe('explorer')
      expect(svc.getActiveViewContainerId(ViewContainerLocation.SecondarySideBar)).toBe(
        'test.outline2',
      )
    })
  })

  describe('cold-start workspace scope settle', () => {
    const tick = () => new Promise((r) => setTimeout(r, 0))

    it('waits for the first scope event before loading, then reloads on genuine switches', async () => {
      let persisted: { activeContainerByLocation: Record<number, string> } | undefined = {
        activeContainerByLocation: { [ViewContainerLocation.SideBar]: 'search' },
      }
      const emitter = new Emitter<void>()
      const storage: IStorageService = {
        ...stubStorage,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        get: async () => persisted as any,
        onDidChangeWorkspaceScope: emitter.event,
      }
      const workspace = { current: null } as unknown as IWorkspaceService
      const svc = new ViewsService(storage, workspace, stubViewDescriptors)

      const loadPromise = svc.load()
      emitter.fire() // hydration lands; consumed by load()'s settle, not a reload
      await loadPromise
      expect(svc.getActiveViewContainerId(ViewContainerLocation.SideBar)).toBe('search')

      // genuine runtime workspace switch: new scope carries a different selection
      persisted = { activeContainerByLocation: { [ViewContainerLocation.SideBar]: 'explorer' } }
      emitter.fire()
      await tick()
      expect(svc.getActiveViewContainerId(ViewContainerLocation.SideBar)).toBe('explorer')
    })

    it('a runtime selection survives the cold-start scope event', async () => {
      const emitter = new Emitter<void>()
      const storage: IStorageService = {
        ...stubStorage,
        onDidChangeWorkspaceScope: emitter.event,
      }
      const workspace = { current: null } as unknown as IWorkspaceService
      const svc = new ViewsService(storage, workspace, stubViewDescriptors)

      const loadPromise = svc.load()
      emitter.fire()
      await loadPromise

      svc.openViewContainer('explorer')
      await tick()
      expect(svc.getActiveViewContainerId(ViewContainerLocation.SideBar)).toBe('explorer')
    })

    it('keeps the runtime selection when switching to a workspace with no persisted views', async () => {
      // No persisted PersistedViews for either scope (fresh mkdtemp folder in
      // the search e2e). A runtime-activated container must NOT be clobbered
      // back to the default when the workspace scope switches.
      const emitter = new Emitter<void>()
      const storage: IStorageService = {
        ...stubStorage,
        get: async () => undefined,
        onDidChangeWorkspaceScope: emitter.event,
      }
      const workspace = { current: null } as unknown as IWorkspaceService
      const svc = new ViewsService(storage, workspace, stubViewDescriptors)

      const loadPromise = svc.load()
      emitter.fire()
      await loadPromise

      svc.openViewContainer('search')
      expect(svc.getActiveViewContainerId(ViewContainerLocation.SideBar)).toBe('search')

      // Genuine runtime workspace switch to an empty-storage folder.
      emitter.fire()
      await tick()
      expect(svc.getActiveViewContainerId(ViewContainerLocation.SideBar)).toBe('search')
    })
  })
})
