import { type ComponentType } from 'react'
import {
  ViewContainerRegistry,
  ViewRegistry,
  IViewsService,
  ViewContainerLocation,
  localize,
} from '@universe-editor/platform'
import type { IPart } from '@universe-editor/platform'
import { useService, useObservable } from '../useService.js'
import { usePartContainer } from '../usePartContainer.js'
import { ViewPaneContainer } from './ViewPaneContainer.js'
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

  const views = ViewRegistry.getViewsForContainer(activeContainer.id)

  return (
    <aside
      ref={containerRef}
      className={styles['sidebar']}
      data-testid="part-sidebar"
      data-active-view-container={activeContainer.id}
      tabIndex={-1}
    >
      <div className={styles['header']}>{activeContainer.label}</div>
      <div className={styles['views']}>
        <ViewPaneContainer
          views={views}
          componentMap={viewComponentMap}
          emptyMessage={localize('sidebar.empty', 'No views registered.')}
        />
      </div>
    </aside>
  )
}
