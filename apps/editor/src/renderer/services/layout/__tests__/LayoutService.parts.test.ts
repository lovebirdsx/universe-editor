import { describe, expect, it, vi } from 'vitest'
import {
  Event,
  type IContextKeyService,
  type IEditorGroupsService,
  type IFocusableRegistry,
  type IPart,
  type IStorageService,
  type IViewsService,
  type IWorkspaceService,
  PartId,
  ViewContainerLocation,
  ViewContainerRegistry,
  ViewRegistry,
} from '@universe-editor/platform'
import { LayoutService } from '../LayoutService.js'
import {
  IViewContainerMemoryService,
  ViewContainerMemoryService,
} from '../../focus/ViewContainerMemoryService.js'

function makeStorage(initial: unknown = undefined): IStorageService {
  return {
    _serviceBrand: undefined,
    get: vi.fn().mockResolvedValue(initial),
    set: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
    onDidChangeWorkspaceScope: Event.None,
  } as unknown as IStorageService
}

function makeViewsService(): IViewsService {
  return {
    _serviceBrand: undefined,
    openViewContainer: vi.fn(),
    getActiveViewContainerId: vi.fn(),
  } as unknown as IViewsService
}

function makeFocusableRegistry(): IFocusableRegistry {
  return {
    _serviceBrand: undefined,
    register: vi.fn(() => ({ dispose() {} })),
    get: vi.fn(),
    onDidChange: Event.None,
  } as unknown as IFocusableRegistry
}

function makeViewContainerMemory(): IViewContainerMemoryService {
  return new ViewContainerMemoryService()
}

function makeEditorGroups(): IEditorGroupsService {
  return {
    _serviceBrand: undefined,
    activeGroup: { id: 0, activeEditor: undefined },
  } as unknown as IEditorGroupsService
}

function makeContextKeyService(): IContextKeyService {
  return {
    _serviceBrand: undefined,
    set: vi.fn(),
    get: vi.fn(),
  } as unknown as IContextKeyService
}

// current non-null keeps reconcileFromStorage() from waiting on the scope event.
function makeWorkspace(): IWorkspaceService {
  return { current: {} } as unknown as IWorkspaceService
}

function newSvc(storage: IStorageService = makeStorage()): LayoutService {
  return new LayoutService(
    storage,
    makeViewsService(),
    makeFocusableRegistry(),
    makeViewContainerMemory(),
    makeEditorGroups(),
    makeContextKeyService(),
    makeWorkspace(),
  )
}

function makePart(id: PartId): IPart {
  return {
    id,
    role: 'region',
    isFocused: () => false,
    visible: { get: () => true } as unknown as IPart['visible'],
    onDidVisibilityChange: () => ({ dispose() {} }),
    mountState: 'unmounted',
    onDidMount: Event.None,
    onDidUnmount: Event.None,
    onDidFocus: Event.None,
    onDidBlur: Event.None,
    whenMounted: () => Promise.resolve(),
    hasPendingFocus: () => false,
    getContainer: () => undefined,
    focus: () => {},
    dispose: () => {},
  }
}

describe('LayoutService — part registry', () => {
  it('registerPart stores the part and getPart can look it up', () => {
    const svc = newSvc()
    const sideBar = makePart(PartId.SideBar)

    svc.registerPart(sideBar)
    expect(svc.getPart(PartId.SideBar)).toBe(sideBar)
    expect(svc.getParts()).toEqual([sideBar])
  })

  it('returns undefined for unregistered ids', () => {
    const svc = newSvc()
    expect(svc.getPart(PartId.Panel)).toBeUndefined()
  })

  it('registerPart returns a disposable that removes the part', () => {
    const svc = newSvc()
    const editor = makePart(PartId.EditorArea)

    const d = svc.registerPart(editor)
    expect(svc.getPart(PartId.EditorArea)).toBe(editor)
    d.dispose()
    expect(svc.getPart(PartId.EditorArea)).toBeUndefined()
    expect(svc.getParts()).toEqual([])
  })

  it('throws when a different part is registered under an already-claimed id', () => {
    const svc = newSvc()
    const first = makePart(PartId.Panel)
    const second = makePart(PartId.Panel)
    svc.registerPart(first)
    expect(() => svc.registerPart(second)).toThrowError(/already registered/)
  })

  it('re-registering the same instance is a no-op', () => {
    const svc = newSvc()
    const p = makePart(PartId.StatusBar)
    svc.registerPart(p)
    expect(() => svc.registerPart(p)).not.toThrow()
    expect(svc.getParts()).toEqual([p])
  })

  it('onDidRegisterPart fires when a part is registered', () => {
    const svc = newSvc()
    const received: IPart[] = []
    svc.onDidRegisterPart((p) => received.push(p))
    const p = makePart(PartId.ActivityBar)
    svc.registerPart(p)
    expect(received).toEqual([p])
  })

  it('disposing then re-registering different parts under the same id works', () => {
    const svc = newSvc()
    const a = makePart(PartId.SideBar)
    const b = makePart(PartId.SideBar)
    const d = svc.registerPart(a)
    d.dispose()
    expect(() => svc.registerPart(b)).not.toThrow()
    expect(svc.getPart(PartId.SideBar)).toBe(b)
  })
})

describe('LayoutService — focus routing', () => {
  const CONTAINER_ID = 'workbench.view.focusProbe'
  const VIEW_ID = 'workbench.view.focusProbe.main'

  it('focusView does not recurse when the part remembers that same view', async () => {
    // Regression: focusView -> focusPart -> "focus the part's last focused
    // view" -> focusView ... blew the stack whenever the remembered view was
    // the one being focused, which is true for any view the user has already
    // focused once (e.g. Show Swarm Reviews after clicking into the view).
    const containerDisposable = ViewContainerRegistry.registerViewContainer({
      id: CONTAINER_ID,
      label: 'Focus Probe',
      icon: 'window',
      order: 99,
      location: ViewContainerLocation.SideBar,
    })
    const viewDisposable = ViewRegistry.registerView({
      id: VIEW_ID,
      name: 'Focus Probe',
      containerId: CONTAINER_ID,
      componentKey: 'focusProbe.main',
      order: 1,
    })

    const memory = new ViewContainerMemoryService()
    memory.setLastFocusedView(CONTAINER_ID, VIEW_ID)
    const views = {
      _serviceBrand: undefined,
      openViewContainer: vi.fn(),
      getActiveViewContainerId: vi.fn(() => CONTAINER_ID),
    } as unknown as IViewsService
    const element = { focus: vi.fn() }
    const registry = {
      _serviceBrand: undefined,
      register: vi.fn(() => ({ dispose() {} })),
      get: vi.fn(() => () => element),
      onDidChange: Event.None,
    } as unknown as IFocusableRegistry

    const svc = new LayoutService(
      makeStorage(),
      views,
      registry,
      memory as unknown as IViewContainerMemoryService,
      makeEditorGroups(),
      makeContextKeyService(),
      makeWorkspace(),
    )
    const part = makePart(PartId.SideBar)
    svc.registerPart(part)

    await expect(svc.focusView(VIEW_ID, { timeoutMs: 200 })).resolves.toBe(true)
    expect(element.focus).toHaveBeenCalledTimes(1)

    containerDisposable.dispose()
    viewDisposable.dispose()
  })
})
