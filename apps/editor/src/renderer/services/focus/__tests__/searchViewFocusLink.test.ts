/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  FocusTracker → FocusStack → RecentTargets end-to-end link, with a real DOM
 *  replicating the SearchView subtree (the case a user reported: focusing the
 *  search box did not bubble the view to the head of the Ctrl+P MRU list).
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  Emitter,
  PartId,
  ViewContainerLocation,
  ViewContainerRegistry,
  ViewRegistry,
  type IEditorGroup,
  type IEditorGroupsService,
  type IStorageService,
  type IViewContainerDescriptor,
  type IViewDescriptor,
  type IViewDescriptorService,
} from '@universe-editor/platform'
import { RendererFocusTrackerService } from '../RendererFocusTrackerService.js'
import { FocusStackService } from '../FocusStackService.js'
import { RecentTargetsService } from '../../editor/RecentTargetsService.js'

/** No workspace history — this spec only exercises the focus→view half. */
function emptyStorage(): IStorageService {
  return {
    get: async () => undefined,
    set: async () => undefined,
    remove: async () => undefined,
    onDidChangeWorkspaceScope: new Emitter<void>().event,
  } as unknown as IStorageService
}

const SEARCH_VIEW_ID = 'workbench.view.search.results'
const EXPLORER_VIEW_ID = 'workbench.view.explorer.tree'

function makeContainer(
  id: string,
  location = ViewContainerLocation.SideBar,
): IViewContainerDescriptor {
  return {
    id,
    label: id,
    icon: 'search',
    order: 0,
    location,
  } as unknown as IViewContainerDescriptor
}

function makeView(id: string, containerId: string): IViewDescriptor {
  return { id, name: id, containerId, componentKey: id } as unknown as IViewDescriptor
}

class FakeViewDescriptorService implements Partial<IViewDescriptorService> {
  declare readonly _serviceBrand: undefined
  constructor(
    private readonly _containers: readonly IViewContainerDescriptor[],
    private readonly _viewsByContainer: ReadonlyMap<string, readonly IViewDescriptor[]>,
  ) {}
  getViewContainersByLocation(loc: ViewContainerLocation): readonly IViewContainerDescriptor[] {
    return this._containers.filter((c) => c.location === loc)
  }
  getViewsByContainer(containerId: string): readonly IViewDescriptor[] {
    return this._viewsByContainer.get(containerId) ?? []
  }
}

/** No editors open — only the focus→view half of RecentTargetsService is exercised. */
class FakeEditorGroupsService implements Partial<IEditorGroupsService> {
  declare readonly _serviceBrand: undefined
  readonly groups: readonly never[] = []
  readonly activeGroup = { id: 0, activeEditor: null } as unknown as IEditorGroup
  readonly onDidActiveGroupChange = new Emitter<never>().event
  readonly onDidAddGroup = new Emitter<never>().event
  readonly onDidRemoveGroup = new Emitter<never>().event
  getGroup(): undefined {
    return undefined
  }
}

/**
 * Replicates the real SearchView DOM: the ViewBody wrapper carries
 * `data-view-id`; the SearchView root inside carries its own
 * `data-testid="search-view"` (which `closestPartId` must walk past); the
 * actual focusable is the search-pattern input.
 */
function buildViewDom(
  doc: Document,
  viewId: string,
  opts: { withSearchTestId?: boolean; withInput?: boolean } = {},
): { viewBody: HTMLElement; input?: HTMLInputElement } {
  const part = doc.createElement('div')
  part.setAttribute('data-testid', 'part-sidebar')

  const viewBody = doc.createElement('div')
  viewBody.setAttribute('data-view-id', viewId)
  viewBody.tabIndex = -1

  let input: HTMLInputElement | undefined
  let inner: HTMLElement = viewBody
  if (opts.withSearchTestId) {
    const searchRoot = doc.createElement('div')
    searchRoot.setAttribute('data-testid', 'search-view')
    viewBody.appendChild(searchRoot)
    inner = searchRoot
  }
  if (opts.withInput) {
    input = doc.createElement('input')
    inner.appendChild(input)
  }
  part.appendChild(viewBody)
  doc.body.appendChild(part)
  return input !== undefined ? { viewBody, input } : { viewBody }
}

describe('focus → MRU link (SearchView scenario)', () => {
  let tracker: RendererFocusTrackerService
  let stack: FocusStackService

  beforeEach(() => {
    document.body.innerHTML = ''
    ViewContainerRegistry.registerViewContainer(makeContainer('workbench.view.search'))
    ViewContainerRegistry.registerViewContainer(makeContainer('workbench.view.explorer'))
    ViewRegistry.registerView(makeView(SEARCH_VIEW_ID, 'workbench.view.search'))
    ViewRegistry.registerView(makeView(EXPLORER_VIEW_ID, 'workbench.view.explorer'))

    tracker = new RendererFocusTrackerService(document)
    const fakeLayout = { getVisible: () => true } as never
    const fakeMemory = { setLastFocusedView: () => {} } as never
    stack = new FocusStackService(tracker, fakeLayout, fakeMemory)
  })

  afterEach(() => {
    stack.dispose()
    tracker.dispose()
    document.body.innerHTML = ''
  })

  it('attributes focus landing in the search-pattern input to the search view', async () => {
    vi.useFakeTimers()
    try {
      const { input } = buildViewDom(document, SEARCH_VIEW_ID, {
        withSearchTestId: true,
        withInput: true,
      })
      input!.dispatchEvent(new FocusEvent('focusin', { bubbles: true, composed: true }))
      await vi.advanceTimersByTimeAsync(0)
      expect(stack.getTop()?.partId).toBe(PartId.SideBar)
      expect(stack.getTop()?.viewId).toBe(SEARCH_VIEW_ID)
    } finally {
      vi.useRealTimers()
    }
  })

  it('attributes focus landing on the ViewBody fallback itself to the search view', async () => {
    vi.useFakeTimers()
    try {
      const { viewBody } = buildViewDom(document, SEARCH_VIEW_ID, { withSearchTestId: true })
      viewBody.dispatchEvent(new FocusEvent('focusin', { bubbles: true, composed: true }))
      await vi.advanceTimersByTimeAsync(0)
      expect(stack.getTop()?.partId).toBe(PartId.SideBar)
      expect(stack.getTop()?.viewId).toBe(SEARCH_VIEW_ID)
    } finally {
      vi.useRealTimers()
    }
  })

  it('bubbles the search view to the head of getRecentViews() after focusing its input', async () => {
    vi.useFakeTimers()
    try {
      const groups = new FakeEditorGroupsService()
      const views = new FakeViewDescriptorService(
        [makeContainer('workbench.view.search'), makeContainer('workbench.view.explorer')],
        new Map([
          ['workbench.view.search', [makeView(SEARCH_VIEW_ID, 'workbench.view.search')]],
          ['workbench.view.explorer', [makeView(EXPLORER_VIEW_ID, 'workbench.view.explorer')]],
        ]),
      )
      const recent = new RecentTargetsService(
        groups as never,
        views as never,
        stack,
        emptyStorage(),
        null!,
      )
      try {
        // Pre-condition: no focus yet → registration order (search registered first).
        expect(recent.getRecentViews().map((v) => v.id)).toEqual([SEARCH_VIEW_ID, EXPLORER_VIEW_ID])

        // Focus explorer first so it becomes MRU head, then search: if the link
        // works, search must jump back above explorer.
        const { viewBody: explorerBody } = buildViewDom(document, EXPLORER_VIEW_ID)
        explorerBody.dispatchEvent(new FocusEvent('focusin', { bubbles: true, composed: true }))
        await vi.advanceTimersByTimeAsync(0)
        expect(recent.getRecentViews().map((v) => v.id)).toEqual([EXPLORER_VIEW_ID, SEARCH_VIEW_ID])

        const { input } = buildViewDom(document, SEARCH_VIEW_ID, {
          withSearchTestId: true,
          withInput: true,
        })
        input!.dispatchEvent(new FocusEvent('focusin', { bubbles: true, composed: true }))
        await vi.advanceTimersByTimeAsync(0)

        expect(recent.getRecentViews().map((v) => v.id)).toEqual([SEARCH_VIEW_ID, EXPLORER_VIEW_ID])
      } finally {
        recent.dispose()
      }
    } finally {
      vi.useRealTimers()
    }
  })
})
