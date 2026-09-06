import { describe, expect, it, vi } from 'vitest'
import {
  Event,
  type IContextKeyService,
  type IDisposable,
  type IEditorGroupsService,
  type IFocusableRegistry,
  type IPart,
  type IStorageService,
  type IViewDescriptorService,
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

/** Only the two reads focusView makes; `collapsed` seeds the initial state. */
function makeViewDescriptors(collapsed = false): IViewDescriptorService {
  return {
    _serviceBrand: undefined,
    getViewState: vi.fn(() => ({ collapsed })),
    setViewCollapsed: vi.fn(),
  } as unknown as IViewDescriptorService
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
    makeViewDescriptors(),
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

  /** Register the probe container + view; caller disposes what comes back. */
  function registerProbeView(): IDisposable {
    const container = ViewContainerRegistry.registerViewContainer({
      id: CONTAINER_ID,
      label: 'Focus Probe',
      icon: 'window',
      order: 99,
      location: ViewContainerLocation.SideBar,
    })
    const view = ViewRegistry.registerView({
      id: VIEW_ID,
      name: 'Focus Probe',
      containerId: CONTAINER_ID,
      componentKey: 'focusProbe.main',
      order: 1,
    })
    return {
      dispose() {
        view.dispose()
        container.dispose()
      },
    }
  }

  function makeProbeViews(): IViewsService {
    return {
      _serviceBrand: undefined,
      openViewContainer: vi.fn(),
      getActiveViewContainerId: vi.fn(() => CONTAINER_ID),
    } as unknown as IViewsService
  }

  /** Registry that always resolves to `element` — never a real DOM node here. */
  function makeRegistryFor(element: unknown): IFocusableRegistry {
    return {
      _serviceBrand: undefined,
      register: vi.fn(() => ({ dispose() {} })),
      get: vi.fn(() => () => element),
      onDidChange: Event.None,
    } as unknown as IFocusableRegistry
  }

  function newFocusSvc(
    registry: IFocusableRegistry,
    viewDescriptors: IViewDescriptorService,
    memory: ViewContainerMemoryService = new ViewContainerMemoryService(),
  ): LayoutService {
    const svc = new LayoutService(
      makeStorage(),
      makeProbeViews(),
      registry,
      memory as unknown as IViewContainerMemoryService,
      makeEditorGroups(),
      makeContextKeyService(),
      makeWorkspace(),
      viewDescriptors,
    )
    svc.registerPart(makePart(PartId.SideBar))
    return svc
  }

  it('focusView does not recurse when the part remembers that same view', async () => {
    // Regression: focusView -> focusPart -> "focus the part's last focused
    // view" -> focusView ... blew the stack whenever the remembered view was
    // the one being focused, which is true for any view the user has already
    // focused once (e.g. Show Swarm Reviews after clicking into the view).
    const registered = registerProbeView()
    const memory = new ViewContainerMemoryService()
    memory.setLastFocusedView(CONTAINER_ID, VIEW_ID)
    const element = { focus: vi.fn() }
    const svc = newFocusSvc(makeRegistryFor(element), makeViewDescriptors(), memory)

    // False, not true: the fake element is not a real DOM node, so focus never
    // lands on it and focusView correctly reports that. What this test guards
    // is that it *returns* at all rather than blowing the stack.
    await expect(svc.focusView(VIEW_ID, { timeoutMs: 200 })).resolves.toBe(false)
    expect(element.focus).toHaveBeenCalled()

    registered.dispose()
  })

  // A collapsed pane renders its view into a display:none subtree, so the
  // registry hands back an element the browser refuses to focus. Expanding is
  // part of focusView's contract rather than each caller's job.
  it('expands the view when it is collapsed', async () => {
    const registered = registerProbeView()
    const viewDescriptors = makeViewDescriptors(true)
    const svc = newFocusSvc(makeRegistryFor({ focus: vi.fn() }), viewDescriptors)

    await svc.focusView(VIEW_ID, { timeoutMs: 50 })

    expect(viewDescriptors.setViewCollapsed).toHaveBeenCalledWith(VIEW_ID, false)
    registered.dispose()
  })

  it('leaves an already-expanded view alone', async () => {
    const registered = registerProbeView()
    const viewDescriptors = makeViewDescriptors(false)
    const svc = newFocusSvc(makeRegistryFor({ focus: vi.fn() }), viewDescriptors)

    await svc.focusView(VIEW_ID, { timeoutMs: 50 })

    expect(viewDescriptors.setViewCollapsed).not.toHaveBeenCalled()
    registered.dispose()
  })

  it('resolves false when no focusable element ever registers', async () => {
    const registered = registerProbeView()
    const registry = {
      _serviceBrand: undefined,
      register: vi.fn(() => ({ dispose() {} })),
      get: vi.fn(() => undefined),
      onDidChange: Event.None,
    } as unknown as IFocusableRegistry
    const svc = newFocusSvc(registry, makeViewDescriptors())

    await expect(svc.focusView(VIEW_ID, { timeoutMs: 50 })).resolves.toBe(false)
    registered.dispose()
  })
})
