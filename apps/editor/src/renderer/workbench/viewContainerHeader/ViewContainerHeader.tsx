/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Compact 28-px header shared by Panel and Secondary Side Bar:
 *   - Left:   icon-only tabs for every ViewContainer at this location
 *             (click switches active container; tooltip shows the label)
 *   - Right:  MenuId.ViewContainerTitle actions for the active container,
 *             resolved through a per-header *scoped* ContextKeyService
 *             that carries `activeViewContainer` and `activeViewContainerLocation`.
 *             Actions therefore follow the container — when a container
 *             moves between Panel and Secondary Side Bar, its title
 *             buttons re-render in the new header automatically.
 *             + optional custom toolbar slot (e.g. dropdowns)
 *             + close button
 *--------------------------------------------------------------------------------------------*/

import type { ComponentType } from 'react'
import { useEffect, useRef } from 'react'
import { X } from 'lucide-react'
import {
  IContextKeyService,
  ILayoutService,
  IViewsService,
  markAsSingleton,
  PartId,
  ViewContainerLocation,
  ViewContainerRegistry,
  localize,
  type IScopedContextKeyService,
} from '@universe-editor/platform'
import { useService, useObservable } from '../useService.js'
import { resolveHeaderIcon } from './icon-map.js'
import { ViewTitleActions } from './ViewTitleActions.js'
import styles from './ViewContainerHeader.module.css'

interface Props {
  location: ViewContainerLocation
  partId: PartId
  /** viewContainerId -> custom right-side React component (e.g. channel dropdown). */
  customToolbarMap?: ReadonlyMap<string, ComponentType>
}

function locationKey(location: ViewContainerLocation): string {
  switch (location) {
    case ViewContainerLocation.Panel:
      return 'panel'
    case ViewContainerLocation.SecondarySideBar:
      return 'auxiliarybar'
    case ViewContainerLocation.SideBar:
      return 'sidebar'
  }
}

export function ViewContainerHeader({ location, partId, customToolbarMap }: Props) {
  const viewsService = useService(IViewsService)
  const layoutService = useService(ILayoutService)
  const rootCtx = useService(IContextKeyService)
  const activeByLocation = useObservable(viewsService.activeContainerByLocation)
  const activeId = activeByLocation[location]

  const scopedCtxRef = useRef<IScopedContextKeyService | null>(null)
  if (scopedCtxRef.current === null) {
    // React useEffect cleanup disposes on unmount, but beforeunload (page
    // reload / Restart Editor) fires before React teardown — mark singleton
    // so the leak tracker doesn't flag this scoped service and its descendants.
    scopedCtxRef.current = markAsSingleton(
      rootCtx.createScoped({
        activeViewContainerLocation: locationKey(location),
        activeViewContainer: activeId,
      }),
    )
  }

  useEffect(() => {
    return () => {
      scopedCtxRef.current?.dispose()
      scopedCtxRef.current = null
    }
  }, [])

  useEffect(() => {
    const s = scopedCtxRef.current
    if (!s) return
    if (activeId) {
      s.set('activeViewContainer', activeId)
    } else {
      s.remove('activeViewContainer')
    }
  }, [activeId])

  const containers = ViewContainerRegistry.getViewContainers(location)
  const isSingle = containers.length <= 1
  const Custom = activeId ? customToolbarMap?.get(activeId) : undefined

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
        {Custom ? <Custom /> : null}
        <ViewTitleActions contextKeyService={scopedCtxRef.current!} />
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
