import { type ComponentType } from 'react'
import {
  ViewContainerRegistry,
  ViewRegistry,
  IViewsService,
  ViewContainerLocation,
  MenuId,
  localize,
} from '@universe-editor/platform'
import type { IPart } from '@universe-editor/platform'
import { useService, useObservable } from '../useService.js'
import { usePartContainer } from '../usePartContainer.js'
import { ViewPaneContainer } from './ViewPaneContainer.js'
import { ViewTitleActions } from '../viewContainerHeader/ViewTitleActions.js'
import { useViewScopedContextKey } from '../viewContainerHeader/useViewScopedContextKey.js'
import { viewToolbarMap } from '../viewRegistry/viewToolbarMap.js'
import { ExplorerView } from '../explorer/ExplorerView.js'
import { SearchView } from '../search/SearchView.js'
import { ScmView } from '../scm/ScmView.js'
import { AgentsView } from '../agents/AgentsView.js'
import { McpServersView } from '../agents/McpServersView.js'
import styles from './SideBar.module.css'

/** Registry of React components keyed by IViewDescriptor.componentKey. */
export const viewComponentMap = new Map<string, ComponentType>()
viewComponentMap.set('explorer.tree', ExplorerView)
viewComponentMap.set('search.results', SearchView)
viewComponentMap.set('scm.main', ScmView)
viewComponentMap.set('agents.main', AgentsView)
viewComponentMap.set('agents.mcp', McpServersView)

export function SideBar({ part }: { part?: IPart | undefined } = {}) {
  const viewsService = useService(IViewsService)
  const activeContainerByLocation = useObservable(viewsService.activeContainerByLocation)
  const activeId = activeContainerByLocation[ViewContainerLocation.SideBar]
  const activeContainer = activeId ? ViewContainerRegistry.getViewContainer(activeId) : undefined
  const containerRef = usePartContainer<HTMLElement>(part)

  const views = activeContainer ? ViewRegistry.getViewsForContainer(activeContainer.id) : []
  const onlyView = views.length === 1 ? views[0] : undefined
  const ctx = useViewScopedContextKey(onlyView?.id)
  const Toolbar = onlyView ? viewToolbarMap.get(onlyView.id) : undefined

  if (!activeContainer) {
    return (
      <aside
        ref={containerRef}
        className={styles['sidebar']}
        data-testid="part-sidebar"
        tabIndex={-1}
      />
    )
  }

  return (
    <aside
      ref={containerRef}
      className={styles['sidebar']}
      data-testid="part-sidebar"
      data-active-view-container={activeContainer.id}
      tabIndex={-1}
    >
      <div className={styles['header']}>
        <span className={styles['headerLabel']}>{activeContainer.label}</span>
        {onlyView ? (
          <div className={styles['headerActions']}>
            {Toolbar ? <Toolbar /> : null}
            <ViewTitleActions menuId={MenuId.ViewTitle} contextKeyService={ctx} />
          </div>
        ) : null}
      </div>
      <div className={styles['views']}>
        <ViewPaneContainer
          views={views}
          componentMap={viewComponentMap}
          toolbarMap={viewToolbarMap}
          emptyMessage={localize('sidebar.empty', 'No views registered.')}
        />
      </div>
    </aside>
  )
}
