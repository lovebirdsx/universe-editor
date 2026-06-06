/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Compact 28-px header shared by Panel and Secondary Side Bar:
 *   - Left:   icon-only tabs for every ViewContainer at this location
 *             (click switches active container; tooltip shows the label)
 *   - Right:  for a single-view container, the lone view's title bar —
 *             an optional custom toolbar + MenuId.ViewTitle actions resolved
 *             through a per-view *scoped* ContextKeyService carrying `view`.
 *             Multi-view containers render nothing here; each view shows its
 *             own actions in its ViewPane header instead.
 *             + close button
 *--------------------------------------------------------------------------------------------*/

import type { ComponentType } from 'react'
import { X } from 'lucide-react'
import {
  ILayoutService,
  IViewsService,
  MenuId,
  PartId,
  ViewContainerLocation,
  ViewContainerRegistry,
  ViewRegistry,
  localize,
} from '@universe-editor/platform'
import { useService, useObservable } from '../useService.js'
import { resolveHeaderIcon } from './icon-map.js'
import { ViewTitleActions } from './ViewTitleActions.js'
import { useViewScopedContextKey } from './useViewScopedContextKey.js'
import styles from './ViewContainerHeader.module.css'

interface Props {
  location: ViewContainerLocation
  partId: PartId
  /** viewId -> custom right-side React component (e.g. channel dropdown). */
  customToolbarMap?: ReadonlyMap<string, ComponentType>
}

export function ViewContainerHeader({ location, partId, customToolbarMap }: Props) {
  const viewsService = useService(IViewsService)
  const layoutService = useService(ILayoutService)
  const activeByLocation = useObservable(viewsService.activeContainerByLocation)
  const activeId = activeByLocation[location]

  const views = activeId ? ViewRegistry.getViewsForContainer(activeId) : []
  const onlyView = views.length === 1 ? views[0] : undefined
  const ctx = useViewScopedContextKey(onlyView?.id)
  const Custom = onlyView ? customToolbarMap?.get(onlyView.id) : undefined

  const containers = ViewContainerRegistry.getViewContainers(location)
  const isSingle = containers.length <= 1

  return (
    <div className={styles['header']} role="tablist">
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
        {onlyView ? (
          <>
            {Custom ? <Custom /> : null}
            <ViewTitleActions menuId={MenuId.ViewTitle} contextKeyService={ctx} />
          </>
        ) : null}
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
