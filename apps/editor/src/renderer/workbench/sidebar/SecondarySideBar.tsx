import {
  ViewContainerRegistry,
  ViewRegistry,
  IViewsService,
  ViewContainerLocation,
} from '@universe-editor/platform'
import type { IPart } from '@universe-editor/platform'
import { useService, useObservable } from '../useService.js'
import { usePartContainer } from '../usePartContainer.js'
import { ViewPane } from './ViewPane.js'
import { viewComponentMap } from './SideBar.js'
import styles from './SideBar.module.css'

export function SecondarySideBar({ part }: { part?: IPart | undefined } = {}) {
  const viewsService = useService(IViewsService)
  const activeContainerByLocation = useObservable(viewsService.activeContainerByLocation)
  const activeId = activeContainerByLocation[ViewContainerLocation.SecondarySideBar]
  const activeContainer = activeId ? ViewContainerRegistry.getViewContainer(activeId) : undefined
  const containerRef = usePartContainer<HTMLElement>(part)

  if (!activeContainer) {
    return <aside ref={containerRef} className={styles['sidebar']} />
  }

  const views = ViewRegistry.getViewsForContainer(activeContainer.id)

  return (
    <aside ref={containerRef} className={styles['sidebar']}>
      <div className={styles['header']}>{activeContainer.label}</div>
      <div className={styles['views']}>
        {views.length === 0 ? (
          <p className={styles['empty']}>No views registered.</p>
        ) : (
          views.map((v) => {
            const Component = viewComponentMap.get(v.componentKey)
            return (
              <ViewPane key={v.id} title={v.name}>
                {Component ? <Component /> : <span className={styles['empty']}>{v.name}</span>}
              </ViewPane>
            )
          })
        )}
      </div>
    </aside>
  )
}
