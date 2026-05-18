import { useState, useEffect, useCallback } from 'react'
import {
  ViewContainerRegistry,
  ViewContainerLocation,
  IViewsService,
  ILayoutService,
  PartId,
  localize,
} from '@universe-editor/platform'
import type { IPart, IViewContainerDescriptor } from '@universe-editor/platform'
import { useService, useObservable } from '../useService.js'
import { usePartContainer } from '../usePartContainer.js'
import { resolveActivityIcon } from './icon-map.js'
import styles from './ActivityBar.module.css'

interface ActivityBarItemProps {
  descriptor: IViewContainerDescriptor
  isActive: boolean
  onClick: () => void
}

function ActivityBarItem({ descriptor, isActive, onClick }: ActivityBarItemProps) {
  const [showTooltip, setShowTooltip] = useState(false)
  const Icon = resolveActivityIcon(descriptor.icon)

  return (
    <button
      className={`${styles['item']} ${isActive ? styles['active'] : ''}`}
      onClick={onClick}
      onMouseEnter={() => setShowTooltip(true)}
      onMouseLeave={() => setShowTooltip(false)}
      title={descriptor.label}
      aria-label={descriptor.label}
      aria-pressed={isActive}
      data-testid={`activitybar-item-${descriptor.id}`}
    >
      <Icon size={18} strokeWidth={1.75} aria-hidden />
      {showTooltip && <span className={styles['tooltip']}>{descriptor.label}</span>}
    </button>
  )
}

export function ActivityBar({ part }: { part?: IPart | undefined } = {}) {
  const viewsService = useService(IViewsService)
  const layoutService = useService(ILayoutService)
  const activeContainerByLocation = useObservable(viewsService.activeContainerByLocation)
  const activeId = activeContainerByLocation[ViewContainerLocation.SideBar]
  const [containers, setContainers] = useState<IViewContainerDescriptor[]>([])
  const containerRef = usePartContainer<HTMLElement>(part)

  useEffect(() => {
    const refresh = () => {
      setContainers([...ViewContainerRegistry.getViewContainers(ViewContainerLocation.SideBar)])
    }
    refresh()
    const disposable = ViewContainerRegistry.onDidRegisterViewContainer(refresh)
    return () => disposable.dispose()
  }, [])

  const handleClick = useCallback(
    (id: string) => {
      const sidebarVisible = layoutService.getVisible(PartId.SideBar)
      if (activeId === id && sidebarVisible) {
        viewsService.closeViewContainer(id)
        layoutService.setVisible(PartId.SideBar, false)
      } else {
        viewsService.openViewContainer(id)
        if (!sidebarVisible) {
          layoutService.setVisible(PartId.SideBar, true)
        }
      }
    },
    [viewsService, layoutService, activeId],
  )

  return (
    <nav
      ref={containerRef}
      className={styles['activitybar']}
      aria-label={localize('menu.activityBar', 'Activity Bar')}
      data-testid="part-activitybar"
    >
      <div className={styles['items']}>
        {containers.map((c) => (
          <ActivityBarItem
            key={c.id}
            descriptor={c}
            isActive={activeId === c.id}
            onClick={() => handleClick(c.id)}
          />
        ))}
      </div>
    </nav>
  )
}
