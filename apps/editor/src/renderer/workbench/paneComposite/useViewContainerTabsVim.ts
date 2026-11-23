/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  Vim adapter for the ViewContainer tab strip (Panel / Secondary Side Bar).
 *  h/l cycle the active container of this location while keeping focus on the
 *  strip, Enter/j hand focus to the active container's first view, gg/G jump to
 *  the first/last container. The strip also publishes itself as the focus
 *  target of `workbench.action.focusViewContainerTabs`.
 *--------------------------------------------------------------------------------------------*/

import { useEffect, useRef } from 'react'
import {
  ILayoutService,
  IViewsService,
  type IViewContainerDescriptor,
  type PartId,
  type ViewContainerLocation,
} from '@universe-editor/platform'
import { createStripVimActions, findRowElement, useVimSurface } from '@universe-editor/workbench-ui'
import { useService } from '../useService.js'
import { useViewDescriptors } from '../dnd/useViewDescriptors.js'
import { registerViewContainerTabsFocus } from './viewContainerTabsFocus.js'

interface ViewContainerTabsState {
  readonly location: ViewContainerLocation
  readonly partId: PartId
  readonly getHeader: () => HTMLElement | null
  readonly getContainers: () => readonly IViewContainerDescriptor[]
}

export interface UseViewContainerTabsVimOptions {
  /** Only tabs-mode headers (Panel / Secondary Side Bar) take Vim keys. */
  readonly enabled: boolean
  readonly location: ViewContainerLocation
  readonly partId: PartId
  readonly getHeader: () => HTMLElement | null
  readonly getContainers: () => readonly IViewContainerDescriptor[]
}

export function viewContainerTabsSurfaceKey(location: ViewContainerLocation): string {
  return `viewContainerTabs:${location}`
}

function activeTabElement(header: HTMLElement | null): HTMLElement | null {
  if (header === null) return null
  const tabs = header.querySelectorAll<HTMLElement>('[role="tab"]')
  return [...tabs].find((tab) => tab.getAttribute('aria-selected') === 'true') ?? null
}

function findContainerTab(header: HTMLElement | null, id: string): HTMLElement | null {
  if (header === null) return null
  return findRowElement(header, 'data-testid', `view-container-tab-${id}`)
}

/**
 * A pending "re-assert strip focus" pass belongs to one switch gesture. A newer
 * h/l or Enter/Escape (which moves focus into content) invalidates it so it
 * cannot pull focus back to the strip afterwards.
 */
let switchRefocusGeneration = 0

export function useViewContainerTabsVim(options: UseViewContainerTabsVimOptions): void {
  const viewsService = useService(IViewsService)
  const layoutService = useService(ILayoutService)
  const viewDescriptors = useViewDescriptors()
  const stateRef = useRef<ViewContainerTabsState>({
    location: options.location,
    partId: options.partId,
    getHeader: options.getHeader,
    getContainers: options.getContainers,
  })
  stateRef.current = {
    location: options.location,
    partId: options.partId,
    getHeader: options.getHeader,
    getContainers: options.getContainers,
  }

  const switchTo = (id: string): void => {
    const generation = ++switchRefocusGeneration
    const state = stateRef.current
    viewsService.openViewContainer(id)
    // All container tabs are mounted at once, so the new tab exists already —
    // focus it synchronously instead of waiting for React to move aria-selected.
    findContainerTab(state.getHeader(), id)?.focus()
    // The newly shown view can focus itself (the terminal instance refits and
    // focuses its xterm), which would take the keyboard away from the strip and
    // make the next h/l a no-op. Re-assert strip focus once that pass settles,
    // but only while focus is still inside this part (never after a click away).
    const header = state.getHeader()
    const ownerDocument = header?.ownerDocument
    const view = ownerDocument?.defaultView
    if (header === null || ownerDocument === undefined || view === undefined || view === null)
      return
    const partRoot = header.closest('[data-testid^="part-"]') ?? header
    view.requestAnimationFrame(() => {
      if (generation !== switchRefocusGeneration) return
      view.requestAnimationFrame(() => {
        if (generation !== switchRefocusGeneration) return
        const active = ownerDocument.activeElement
        if (active === null || active === findContainerTab(state.getHeader(), id)) return
        if (partRoot.contains(active)) findContainerTab(state.getHeader(), id)?.focus()
      })
    })
  }

  // The strip cycles around the ends; the cursor is the container the location
  // currently shows (-1 when none is active yet).
  const stripActions = createStripVimActions({
    getCount: () => stateRef.current.getContainers().length,
    getIndex: () => {
      const state = stateRef.current
      const activeId = viewsService.getActiveViewContainerId(state.location)
      return state.getContainers().findIndex((container) => container.id === activeId)
    },
    setIndex: (index) => {
      const target = stateRef.current.getContainers()[index]
      if (target !== undefined) switchTo(target.id)
    },
    wrap: true,
  })

  const focusContainerContent = (): void => {
    // Enter/Escape is choosing the content as the focus destination; cancel any
    // pending strip refocus from the switch that showed it.
    switchRefocusGeneration++
    const state = stateRef.current
    const activeId = viewsService.getActiveViewContainerId(state.location)
    const container = state.getContainers().find((candidate) => candidate.id === activeId)
    if (container === undefined) return
    const firstViewId = viewDescriptors.getViewsByContainer(container.id)[0]?.id
    layoutService.setVisible(state.partId, true)
    if (firstViewId !== undefined) {
      void layoutService.focusView(firstViewId, { source: 'user' })
      return
    }
    viewsService.openViewContainer(container.id)
  }

  useVimSurface({
    id: viewContainerTabsSurfaceKey(options.location),
    kind: 'viewContainerTabs',
    focus: 'within',
    enabled: options.enabled,
    getElement: () => stateRef.current.getHeader(),
    getSurfaceKey: () => viewContainerTabsSurfaceKey(stateRef.current.location),
    defaultMode: 'normal',
    actions: {
      ...stripActions,
      activate: focusContainerContent,
      escape: focusContainerContent,
    },
  })

  // Let `workbench.action.focusViewContainerTabs` reach this strip. Label-mode
  // headers have no tabs, so they never register.
  useEffect(() => {
    if (!options.enabled) return undefined
    return registerViewContainerTabsFocus(options.location, () => {
      const active = activeTabElement(stateRef.current.getHeader())
      if (active === null) return false
      active.focus()
      return true
    }).dispose
  }, [options.enabled, options.location])
}
