/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Unified header for the PaneCompositePart, two forms selected by `mode`:
 *   - 'label': a text title showing the active container's label (SideBar form;
 *              container switching lives in the ActivityBar). For a single-view
 *              container the lone view's actions sit on the right.
 *   - 'tabs':  icon-only tabs for every ViewContainer at this location plus a
 *              close button (Panel / Secondary Side Bar form; these have no
 *              dedicated ActivityBar). Single-view actions sit on the right too.
 *  Right-side actions in both forms = optional custom toolbar + MenuId.ViewTitle
 *  actions resolved through a per-view scoped ContextKeyService carrying `view`.
 *--------------------------------------------------------------------------------------------*/

import { useState, type DragEvent } from 'react'
import { Maximize2, Minimize2, X } from 'lucide-react'
import {
  ILayoutService,
  IViewsService,
  MenuId,
  PartId,
  ViewContainerLocation,
  localize,
} from '@universe-editor/platform'
import type { IViewContainerDescriptor, IViewDescriptor } from '@universe-editor/platform'
import { useService, useObservable } from '../useService.js'
import { useViewDescriptors } from '../dnd/useViewDescriptors.js'
import { VIEW_DRAG_MIME, dragContainsView, viewDragData } from '../dnd/viewDragData.js'
import { applyViewDrop } from '../dnd/applyViewDrop.js'
import { resolveHeaderIcon } from '../viewContainerHeader/icon-map.js'
import { resolveContainerIconName } from '../icons/resolveContainerIcon.js'
import { ViewTitleActions } from '../viewContainerHeader/ViewTitleActions.js'
import { useViewScopedContextKey } from '../viewContainerHeader/useViewScopedContextKey.js'
import { viewToolbarMap } from '../viewRegistry/viewToolbarMap.js'
import styles from './PaneComposite.module.css'

interface Props {
  mode: 'label' | 'tabs'
  location: ViewContainerLocation
  partId: PartId
  activeContainer: IViewContainerDescriptor | undefined
  onlyView: IViewDescriptor | undefined
}

export function PaneCompositeHeader({ mode, location, partId, activeContainer, onlyView }: Props) {
  const viewsService = useService(IViewsService)
  const layoutService = useService(ILayoutService)
  const viewDescriptors = useViewDescriptors()
  const panelMaximized = useObservable(layoutService.panelMaximized)
  const ctx = useViewScopedContextKey(onlyView?.id)
  const Custom = onlyView ? viewToolbarMap.get(onlyView.id) : undefined
  const [dropTarget, setDropTarget] = useState<
    { id: string; edge: 'before' | 'after' | 'merge' } | undefined
  >(undefined)
  const [locationDropActive, setLocationDropActive] = useState(false)

  const actions = onlyView ? (
    <>
      {Custom ? <Custom /> : null}
      <ViewTitleActions menuId={MenuId.ViewTitle} contextKeyService={ctx} />
    </>
  ) : null

  if (mode === 'label') {
    return (
      <div className={styles['labelHeader']}>
        <span className={styles['headerLabel']}>{activeContainer?.label}</span>
        {actions ? <div className={styles['headerActions']}>{actions}</div> : null}
      </div>
    )
  }

  const activeId = activeContainer?.id
  const containers = viewDescriptors.getViewContainersByLocation(location)
  const isSingle = containers.length <= 1
  const isPanel = location === ViewContainerLocation.Panel

  const dropPayload = (e: DragEvent) =>
    dragContainsView(e.dataTransfer) ? viewDragData.get() : undefined

  const tabEdge = (e: DragEvent): 'before' | 'after' | 'merge' => {
    const rect = e.currentTarget.getBoundingClientRect()
    const offset = (e.clientX - rect.left) / rect.width
    return offset < 0.25 ? 'before' : offset > 0.75 ? 'after' : 'merge'
  }

  const onTabDragOver = (targetId: string) => (e: DragEvent) => {
    const payload = dropPayload(e)
    if (!payload) return
    if (payload.kind === 'container' && payload.id === targetId) return
    e.preventDefault()
    e.stopPropagation()
    e.dataTransfer.dropEffect = 'move'
    setLocationDropActive(false)
    setDropTarget({ id: targetId, edge: payload.kind === 'container' ? tabEdge(e) : 'merge' })
  }

  const onTabDrop = (targetId: string) => (e: DragEvent) => {
    const payload = dropPayload(e)
    if (!payload) {
      setDropTarget(undefined)
      return
    }
    e.preventDefault()
    e.stopPropagation()
    const merge = payload.kind === 'container' ? tabEdge(e) === 'merge' : false
    setDropTarget(undefined)
    applyViewDrop(viewDescriptors, payload, { kind: 'container', containerId: targetId, merge })
  }

  const onLocationDragOver = (e: DragEvent) => {
    const payload = dropPayload(e)
    if (!payload) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    setLocationDropActive(true)
  }

  const onLocationDrop = (e: DragEvent) => {
    const payload = dropPayload(e)
    setLocationDropActive(false)
    if (!payload) return
    e.preventDefault()
    applyViewDrop(viewDescriptors, payload, { kind: 'location', location })
  }

  return (
    <div
      className={`${styles['tabsHeader']} ${locationDropActive ? styles['tabsLocationDrop'] : ''}`}
      role="tablist"
      onDragOver={onLocationDragOver}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setLocationDropActive(false)
      }}
      onDrop={onLocationDrop}
    >
      <div className={styles['tabs']}>
        {containers.map((c) => {
          const Icon = resolveHeaderIcon(resolveContainerIconName(c, viewDescriptors))
          const active = c.id === activeId
          const edge = dropTarget?.id === c.id ? dropTarget.edge : undefined
          const tabClass = [
            styles['tab'],
            active ? styles['active'] : '',
            edge === 'before' ? styles['dropBefore'] : '',
            edge === 'after' ? styles['dropAfter'] : '',
            edge === 'merge' ? styles['dropMerge'] : '',
          ]
            .filter(Boolean)
            .join(' ')
          return (
            <button
              key={c.id}
              className={tabClass}
              role="tab"
              aria-selected={active}
              title={c.label}
              aria-label={c.label}
              data-testid={`view-container-tab-${c.id}`}
              draggable
              onDragStart={(e) => {
                viewDragData.set({ kind: 'container', id: c.id })
                e.dataTransfer.setData(VIEW_DRAG_MIME, c.id)
                e.dataTransfer.effectAllowed = 'move'
              }}
              onDragEnd={() => {
                viewDragData.clear()
                setDropTarget(undefined)
                setLocationDropActive(false)
              }}
              onDragOver={onTabDragOver(c.id)}
              onDragLeave={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node | null))
                  setDropTarget(undefined)
              }}
              onDrop={onTabDrop(c.id)}
              onClick={() => {
                if (!isSingle) viewsService.openViewContainer(c.id)
              }}
            >
              {Icon ? (
                <Icon size={17} strokeWidth={1.75} aria-hidden="true" />
              ) : (
                <span className={styles['tabFallback']}>{c.label.slice(0, 2)}</span>
              )}
            </button>
          )
        })}
      </div>
      <div className={styles['toolbar']}>
        {actions}
        {isPanel ? (
          <button
            className={styles['closeBtn']}
            onClick={() => layoutService.togglePanelMaximized()}
            title={
              panelMaximized
                ? localize('panel.restore', 'Restore Panel Size')
                : localize('panel.maximize', 'Maximize Panel Size')
            }
            aria-label={
              panelMaximized
                ? localize('panel.restore', 'Restore Panel Size')
                : localize('panel.maximize', 'Maximize Panel Size')
            }
            data-testid={`view-container-header-maximize-${partId}`}
          >
            {panelMaximized ? (
              <Minimize2 size={16} strokeWidth={1.75} aria-hidden="true" />
            ) : (
              <Maximize2 size={16} strokeWidth={1.75} aria-hidden="true" />
            )}
          </button>
        ) : null}
        <button
          className={styles['closeBtn']}
          onClick={() => layoutService.setVisible(partId, false)}
          title={localize('viewContainer.close', 'Close')}
          aria-label={localize('viewContainer.close', 'Close')}
          data-testid={`view-container-header-close-${partId}`}
        >
          <X size={16} strokeWidth={1.75} aria-hidden="true" />
        </button>
      </div>
    </div>
  )
}
