import { useState, useEffect, type ComponentType } from 'react'
import {
  ViewContainerRegistry,
  ViewRegistry,
  IViewsService,
  ViewContainerLocation,
} from '@universe-editor/platform'
import type { IViewContainerDescriptor } from '@universe-editor/platform'
import { useService } from '../useService.js'
import { ViewPane } from './ViewPane.js'
import styles from './SideBar.module.css'

/** Registry of React components keyed by IViewDescriptor.componentKey. */
export const viewComponentMap = new Map<string, ComponentType>()

export function SideBar() {
  const viewsService = useService(IViewsService)
  const [activeContainer, setActiveContainer] = useState<IViewContainerDescriptor | undefined>(
    undefined,
  )

  useEffect(() => {
    const disposable = viewsService.onDidChangeViewContainerVisibility((e) => {
      if (e.location !== ViewContainerLocation.SideBar) return
      if (e.visible) {
        setActiveContainer(ViewContainerRegistry.getViewContainer(e.containerId))
      } else {
        setActiveContainer((prev) => (prev?.id === e.containerId ? undefined : prev))
      }
    })
    return () => disposable.dispose()
  }, [viewsService])

  if (!activeContainer) {
    return <aside className={styles['sidebar']} />
  }

  const views = ViewRegistry.getViewsForContainer(activeContainer.id)

  return (
    <aside className={styles['sidebar']}>
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
