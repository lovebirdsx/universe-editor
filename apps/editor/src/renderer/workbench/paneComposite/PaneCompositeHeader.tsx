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

import { X } from 'lucide-react'
import {
  ILayoutService,
  IViewsService,
  MenuId,
  PartId,
  ViewContainerLocation,
  ViewContainerRegistry,
  localize,
} from '@universe-editor/platform'
import type { IViewContainerDescriptor, IViewDescriptor } from '@universe-editor/platform'
import { useService } from '../useService.js'
import { resolveHeaderIcon } from '../viewContainerHeader/icon-map.js'
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
  const ctx = useViewScopedContextKey(onlyView?.id)
  const Custom = onlyView ? viewToolbarMap.get(onlyView.id) : undefined

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
  const containers = ViewContainerRegistry.getViewContainers(location)
  const isSingle = containers.length <= 1

  return (
    <div className={styles['tabsHeader']} role="tablist">
      <div className={styles['tabs']}>
        {containers.map((c) => {
          const Icon = resolveHeaderIcon(c.icon)
          const active = c.id === activeId
          return (
            <button
              key={c.id}
              className={`${styles['tab']} ${active ? styles['active'] : ''}`}
              role="tab"
              aria-selected={active}
              title={c.label}
              aria-label={c.label}
              data-testid={`view-container-tab-${c.id}`}
              onClick={() => {
                if (!isSingle) viewsService.openViewContainer(c.id)
              }}
              disabled={isSingle}
            >
              {Icon ? (
                <Icon size={14} strokeWidth={1.75} aria-hidden="true" />
              ) : (
                <span className={styles['tabFallback']}>{c.label.slice(0, 2)}</span>
              )}
            </button>
          )
        })}
      </div>
      <div className={styles['toolbar']}>
        {actions}
        <button
          className={styles['closeBtn']}
          onClick={() => layoutService.setVisible(partId, false)}
          title={localize('viewContainer.close', 'Close')}
          aria-label={localize('viewContainer.close', 'Close')}
          data-testid={`view-container-header-close-${partId}`}
        >
          <X size={14} strokeWidth={1.75} aria-hidden="true" />
        </button>
      </div>
    </div>
  )
}
