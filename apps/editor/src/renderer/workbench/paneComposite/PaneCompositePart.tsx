/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Unified Part that hosts a ViewContainer location (SideBar / SecondarySideBar /
 *  Panel). The three areas share one data flow — read the active container for
 *  the location, resolve its views — and differ only along the axes captured in
 *  PaneCompositeConfig (header form, content form). Mirrors VSCode's
 *  AbstractPaneCompositePart, but as a declarative React component.
 *--------------------------------------------------------------------------------------------*/

import { createElement, type ComponentType, type ReactNode } from 'react'
import { IViewsService, ViewContainerRegistry, ViewRegistry } from '@universe-editor/platform'
import type { IPart } from '@universe-editor/platform'
import { useService, useObservable } from '../useService.js'
import { usePartContainer } from '../usePartContainer.js'
import { ViewPaneContainer } from '../sidebar/ViewPaneContainer.js'
import { viewToolbarMap } from '../viewRegistry/viewToolbarMap.js'
import { ViewComponentRegistry } from '../../services/views/ViewComponentRegistry.js'
import { PaneCompositeHeader } from './PaneCompositeHeader.js'
import { TiledViews } from './TiledViews.js'
import type { PaneCompositeConfig } from './paneCompositeConfigs.js'
import styles from './PaneComposite.module.css'

const resolveViewComponent = (componentKey: string): ComponentType | undefined =>
  ViewComponentRegistry.get(componentKey)

interface Props {
  part?: IPart | undefined
  config: PaneCompositeConfig
}

export function PaneCompositePart({ part, config }: Props) {
  const viewsService = useService(IViewsService)
  const activeByLocation = useObservable(viewsService.activeContainerByLocation)
  const activeId = activeByLocation[config.location]
  const activeContainer = activeId ? ViewContainerRegistry.getViewContainer(activeId) : undefined
  const containerRef = usePartContainer<HTMLElement>(part)

  const views = activeContainer ? ViewRegistry.getViewsForContainer(activeContainer.id) : []
  const onlyView = views.length === 1 ? views[0] : undefined

  const rootProps: Record<string, unknown> = {
    ref: containerRef,
    className: config.rootTag === 'aside' ? styles['sidebar'] : styles['panel'],
    'data-testid': config.testId,
    'data-active-view-container': activeContainer?.id ?? '',
    tabIndex: -1,
  }
  if (config.exposeActiveView) rootProps['data-active-view'] = onlyView?.id

  // Text-label header has nothing to show without an active container, so the
  // root stays empty (preserves SideBar's prior behavior). The tabs header is
  // always rendered so its tab strip remains visible.
  if (!activeContainer && config.header === 'label') {
    return createElement(config.rootTag, rootProps)
  }

  const header = (
    <PaneCompositeHeader
      mode={config.header}
      location={config.location}
      partId={config.partId}
      activeContainer={activeContainer}
      onlyView={onlyView}
    />
  )

  const content: ReactNode =
    config.content === 'stack' ? (
      <div className={styles['views']}>
        <ViewPaneContainer
          views={views}
          resolve={resolveViewComponent}
          toolbarMap={viewToolbarMap}
          {...(config.emptyMessage ? { emptyMessage: config.emptyMessage } : {})}
        />
      </div>
    ) : (
      <TiledViews views={views} resolve={resolveViewComponent} />
    )

  return createElement(config.rootTag, rootProps, header, content)
}
