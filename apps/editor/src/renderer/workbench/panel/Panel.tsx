import type { ComponentType } from 'react'
import {
  IViewsService,
  PartId,
  ViewContainerLocation,
  ViewContainerRegistry,
  ViewRegistry,
} from '@universe-editor/platform'
import type { IPart } from '@universe-editor/platform'
import { useService, useObservable } from '../useService.js'
import { usePartContainer } from '../usePartContainer.js'
import { ViewContainerHeader } from '../viewContainerHeader/ViewContainerHeader.js'
import { viewToolbarMap } from '../viewRegistry/viewToolbarMap.js'
import { OutputView } from './output/OutputView.js'
import { TerminalView } from './terminal/TerminalView.js'
import styles from './Panel.module.css'

/** Registry of React components keyed by IViewDescriptor.componentKey. */
const panelViewComponentMap = new Map<string, ComponentType>([
  ['output.main', OutputView],
  ['terminal.main', TerminalView],
])

export function Panel({ part }: { part?: IPart | undefined } = {}) {
  const containerRef = usePartContainer(part)
  const viewsService = useService(IViewsService)
  const activeByLocation = useObservable(viewsService.activeContainerByLocation)
  const activeId = activeByLocation[ViewContainerLocation.Panel]
  const activeContainer = activeId ? ViewContainerRegistry.getViewContainer(activeId) : undefined
  const views = activeContainer ? ViewRegistry.getViewsForContainer(activeContainer.id) : []

  return (
    <div
      ref={containerRef}
      className={styles['panel']}
      data-testid="part-panel"
      data-active-view-container={activeContainer?.id ?? ''}
    >
      <ViewContainerHeader
        location={ViewContainerLocation.Panel}
        partId={PartId.Panel}
        customToolbarMap={viewToolbarMap}
      />
      <div className={styles['content']}>
        {views.map((v) => {
          const Component = panelViewComponentMap.get(v.componentKey)
          return Component ? (
            <div key={v.id} data-view-id={v.id} className={styles['viewBody'] ?? ''}>
              <Component />
            </div>
          ) : null
        })}
      </div>
    </div>
  )
}
