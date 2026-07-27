import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import {
  IViewDescriptorService,
  InstantiationService,
  ServiceCollection,
  ViewContainerLocation,
  ViewContainerRegistry,
  ViewRegistry,
  type IStorageService,
  type IWorkspaceService,
} from '@universe-editor/platform'
import { IViewsService } from '@universe-editor/platform'
import { ViewsService } from '../../../services/views/ViewsService.js'
import { ViewDescriptorService } from '../../../services/views/ViewDescriptorService.js'
import { ViewComponentRegistry } from '../../../services/views/ViewComponentRegistry.js'
import { ServicesContext } from '../../useService.js'
import { PaneCompositePart } from '../../paneComposite/PaneCompositePart.js'
import { sideBarConfig } from '../../paneComposite/paneCompositeConfigs.js'

vi.mock('../../paneComposite/PaneCompositeHeader.js', () => ({
  PaneCompositeHeader: () => <div data-testid="view-container-header" />,
}))

vi.mock('../ViewPane.js', () => ({
  ViewPane: ({
    title,
    children,
    open,
  }: {
    title: string
    children: React.ReactNode
    open: boolean
  }) => (
    <div data-testid={`view-pane-${title}`} data-open={open}>
      {children}
    </div>
  ),
}))

type ROEntry = { contentRect: { width: number; height: number } }
const roCallbacks: Array<(entries: ROEntry[]) => void> = []

class FakeResizeObserver {
  constructor(callback: (entries: ROEntry[]) => void) {
    roCallbacks.push(callback)
  }
  observe() {}
  unobserve() {}
  disconnect() {}
}

function fireLastResizeObserver(width: number, height: number) {
  const callback = roCallbacks[roCallbacks.length - 1]
  if (!callback) throw new Error('no ResizeObserver instance')
  callback([{ contentRect: { width, height } }])
}

/** Rendered pane height (allotment's internal split-view-view wrapper), in px. */
function paneHeightPx(viewTitle: string): number {
  const pane = screen.getByTestId(`view-pane-${viewTitle}`)
  const wrapper = pane.closest<HTMLElement>('[data-testid="split-view-view"]')
  if (!wrapper) throw new Error(`no split-view-view wrapper for ${viewTitle}`)
  return Number.parseFloat(wrapper.style.height)
}

function makeStorage(): IStorageService & { set: ReturnType<typeof vi.fn> } {
  return {
    _serviceBrand: undefined,
    get: vi.fn().mockResolvedValue(undefined),
    set: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
    onDidChangeWorkspaceScope: () => ({ dispose: () => {} }),
  } as unknown as IStorageService & { set: ReturnType<typeof vi.fn> }
}

const stubWorkspace = { current: {} } as unknown as IWorkspaceService

const CONTAINER_ID = 'test.container'

function renderSideBar(
  viewDescriptorService = new ViewDescriptorService(makeStorage(), stubWorkspace),
) {
  const services = new ServiceCollection()
  services.set(IViewDescriptorService, viewDescriptorService)
  const viewsService = new ViewsService(makeStorage(), stubWorkspace, viewDescriptorService)
  viewsService.openViewContainer(CONTAINER_ID)
  services.set(IViewsService, viewsService)
  const inst = new InstantiationService(services)
  const result = render(
    <ServicesContext.Provider value={inst}>
      <PaneCompositePart part={undefined} config={sideBarConfig} />
    </ServicesContext.Provider>,
  )
  return { viewDescriptorService, ...result }
}

describe('ViewPaneContainer', () => {
  const disposables: Array<{ dispose: () => void }> = []

  beforeEach(() => {
    roCallbacks.length = 0
    vi.stubGlobal('ResizeObserver', FakeResizeObserver)
    disposables.push(
      ViewContainerRegistry.registerViewContainer({
        id: CONTAINER_ID,
        label: 'Test',
        icon: 'test',
        order: 1,
        location: ViewContainerLocation.SideBar,
      }),
    )
    for (const [index, id] of ['test.view.a', 'test.view.b'].entries()) {
      disposables.push(
        ViewRegistry.registerView({
          id,
          name: id,
          containerId: CONTAINER_ID,
          componentKey: `test.component.${id}`,
          order: index,
        }),
      )
      disposables.push(
        ViewComponentRegistry.register(`test.component.${id}`, () => <div>{id}</div>),
      )
    }
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    while (disposables.length) disposables.pop()?.dispose()
  })

  it('collapses to the header and hands freed space to the open pane, keeping the collapsed pane’s stored size', () => {
    const { viewDescriptorService } = renderSideBar()
    act(() => fireLastResizeObserver(800, 600))
    expect(viewDescriptorService.getViewState('test.view.a').size).toBe(300)

    act(() => viewDescriptorService.setViewCollapsed('test.view.a', true))

    // The collapsed pane keeps its remembered expanded size (not the 28px
    // header); the open pane absorbs the freed space.
    expect(viewDescriptorService.getViewState('test.view.a').size).toBe(300)
    expect(viewDescriptorService.getViewState('test.view.b').size).toBe(572)
  })

  it('expanding a collapsed pane restores its remembered size', () => {
    const { viewDescriptorService } = renderSideBar()
    act(() => fireLastResizeObserver(800, 600))
    act(() => viewDescriptorService.setViewCollapsed('test.view.a', true))
    expect(viewDescriptorService.getViewState('test.view.b').size).toBe(572)

    act(() => viewDescriptorService.setViewCollapsed('test.view.a', false))

    expect(viewDescriptorService.getViewState('test.view.a').size).toBe(300)
    expect(viewDescriptorService.getViewState('test.view.b').size).toBe(300)
  })

  it('collapsing persists the remembered expanded size', async () => {
    // With onChange bookkeeping no longer persisted, the collapse action is
    // the only path that lands the remembered expanded size on disk — assert
    // the debounced save actually fires (a bare save() would flush the
    // in-memory bookkeeping regardless, making the assertion tautological).
    vi.useFakeTimers()
    try {
      const storage = makeStorage()
      const viewDescriptorService = new ViewDescriptorService(storage, stubWorkspace)
      renderSideBar(viewDescriptorService)
      act(() => fireLastResizeObserver(800, 600))

      act(() => viewDescriptorService.setViewCollapsed('test.view.a', true))
      await act(async () => {
        await vi.advanceTimersByTimeAsync(250)
      })

      expect(storage.set).toHaveBeenCalledWith(
        'workbench.viewCustomizations',
        expect.objectContaining({
          viewStates: expect.objectContaining({
            'test.view.a': expect.objectContaining({ size: 300 }),
          }),
        }),
        expect.anything(),
      )
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not resize against a remounted Allotment whose panes are not reconciled yet', () => {
    const { viewDescriptorService } = renderSideBar()
    act(() => fireLastResizeObserver(800, 600))
    expect(viewDescriptorService.getViewState('test.view.a').size).toBe(300)

    // Reorder → viewIdsKey changes → Allotment remounts with an empty SplitView
    // whose panes only appear after the next ResizeObserver tick. The collapse
    // landing in that window must not drive resize() against the stale geometry.
    act(() => viewDescriptorService.moveViewInContainer(CONTAINER_ID, 'test.view.b', 'test.view.a'))
    act(() => viewDescriptorService.setViewCollapsed('test.view.a', true))

    expect(screen.getByTestId('view-pane-test.view.a')).toBeTruthy()
  })

  it('corrects pane sizes when the persisted-size reconcile lands after the first layout pass', async () => {
    // main.tsx defers reconcileFromStorage() off the first-paint path, so a
    // slow WORKSPACE-storage read can resolve AFTER Allotment's ResizeObserver
    // already committed to a pre-reconcile equal split (300/300 here).
    let resolveGet: (value: unknown) => void = () => {}
    const deferredStorage = {
      _serviceBrand: undefined,
      get: vi.fn(() => new Promise((resolve) => (resolveGet = resolve))),
      set: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn().mockResolvedValue(undefined),
      onDidChangeWorkspaceScope: () => ({ dispose: () => {} }),
    } as unknown as IStorageService

    const viewDescriptorService = new ViewDescriptorService(deferredStorage, stubWorkspace)
    renderSideBar(viewDescriptorService)

    act(() => fireLastResizeObserver(800, 600))
    expect(viewDescriptorService.getViewState('test.view.a').size).toBe(300)
    expect(viewDescriptorService.getViewState('test.view.b').size).toBe(300)
    expect(paneHeightPx('test.view.a')).toBe(300)
    expect(paneHeightPx('test.view.b')).toBe(300)

    const reconcile = viewDescriptorService.reconcileFromStorage()
    await act(async () => {
      resolveGet({
        viewStates: {
          'test.view.a': { size: 200 },
          'test.view.b': { size: 400 },
        },
      })
      await reconcile
    })

    // Allotment freezes each pane's layoutStrategy at construction — a late
    // reconcile must be applied imperatively via resize(), reflected in the
    // actual rendered pane heights, not just the service's bookkeeping.
    expect(paneHeightPx('test.view.a')).toBe(200)
    expect(paneHeightPx('test.view.b')).toBe(400)
  })

  it('never persists the pre-reconcile first-layout split (reload race regression)', async () => {
    // Regression for the CI flake where a reload landing within the save
    // debounce window persisted the pre-reconcile equal split over the dragged
    // sizes: the first onChange report must stay in-memory only, so the
    // debounced save never fires on its own.
    vi.useFakeTimers()
    try {
      const storage = makeStorage()
      const viewDescriptorService = new ViewDescriptorService(storage, stubWorkspace)
      renderSideBar(viewDescriptorService)
      act(() => fireLastResizeObserver(800, 600))
      expect(viewDescriptorService.getViewState('test.view.a').size).toBe(300)

      // Past the 200ms save debounce and the 600ms first-layout correction
      // window: no automatic persist must have happened.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000)
      })
      expect(storage.set).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('a later render cannot lock in layout noise over the reconciled sizes', async () => {
    // Regression for the CI flake where the restored pane drifted to the
    // greedy first-layout split (second pane pinned to its 88px min): the
    // reconcile lands BEFORE Allotment's first layout, the first onChange
    // corrects the split visually, but its raw report still overwrites the
    // live bookkeeping. A later unrelated version bump re-renders the
    // container and must still target the persisted sizes — never the
    // polluted live ones.
    const storage = makeStorage()
    storage.get = vi.fn().mockResolvedValue({
      viewStates: {
        'test.view.a': { size: 200 },
        'test.view.b': { size: 400 },
      },
    })
    const viewDescriptorService = new ViewDescriptorService(storage, stubWorkspace)
    renderSideBar(viewDescriptorService)

    // Fast storage: reconcile lands before the first layout pass.
    await act(async () => {
      await viewDescriptorService.reconcileFromStorage()
    })
    expect(viewDescriptorService.getPersistedViewSize('test.view.a')).toBe(200)

    // First layout reports the pre-reconcile split (300/300): the one-shot
    // correction restores the persisted split visually. In a real browser the
    // correction's resize() fires its onChange synchronously, so the outer
    // onChange's bookkeeping afterwards overwrites the live state with the
    // pre-reconcile split (the pollution vector) — happy-dom delivers that
    // nested onChange asynchronously, so inject the equivalent noise write
    // directly.
    act(() => fireLastResizeObserver(800, 600))
    expect(paneHeightPx('test.view.a')).toBe(200)
    expect(paneHeightPx('test.view.b')).toBe(400)
    act(() =>
      viewDescriptorService.setViewSizes([
        { id: 'test.view.a', size: 300 },
        { id: 'test.view.b', size: 300 },
      ]),
    )
    expect(viewDescriptorService.getViewState('test.view.a').size).toBe(300)

    // A later unrelated registry bump re-renders the container.
    act(() => {
      disposables.push(
        ViewRegistry.registerView({
          id: 'test.view.unrelated',
          name: 'test.view.unrelated',
          containerId: 'test.other.container',
          componentKey: 'test.component.unrelated',
          order: 1,
        }),
      )
    })

    // The rendered split must still be the persisted one.
    expect(paneHeightPx('test.view.a')).toBe(200)
    expect(paneHeightPx('test.view.b')).toBe(400)
  })

  it('keeps correcting startup geometry redistribution within the settle window', async () => {
    // Regression for the residual CI flake: the first-layout correction ran,
    // then the window's own startup geometry settle re-sized the container and
    // Allotment redistributed the panes again (no further stored-sizes key
    // change to retrigger the effect). Reports inside the settle window must
    // keep correcting toward the persisted sizes.
    const storage = makeStorage()
    storage.get = vi.fn().mockResolvedValue({
      viewStates: {
        'test.view.a': { size: 200 },
        'test.view.b': { size: 400 },
      },
    })
    const viewDescriptorService = new ViewDescriptorService(storage, stubWorkspace)
    renderSideBar(viewDescriptorService)
    await act(async () => {
      await viewDescriptorService.reconcileFromStorage()
    })

    // First layout: corrected to the persisted split.
    act(() => fireLastResizeObserver(800, 600))
    expect(paneHeightPx('test.view.a')).toBe(200)
    expect(paneHeightPx('test.view.b')).toBe(400)

    // The container's startup geometry settles through a smaller intermediate
    // height, redistributing the panes away from the persisted split...
    act(() => fireLastResizeObserver(800, 300))
    // ...and lands at its final height. Without continuous in-window
    // correction the panes stay at whatever the redistribution produced.
    act(() => fireLastResizeObserver(800, 600))

    expect(paneHeightPx('test.view.a')).toBe(200)
    expect(paneHeightPx('test.view.b')).toBe(400)
  })
})
