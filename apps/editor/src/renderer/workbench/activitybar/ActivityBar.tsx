import { useState, useEffect, useCallback } from 'react'
import {
  ViewContainerRegistry,
  ViewContainerLocation,
  IViewsService,
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
    >
      <Icon size={18} strokeWidth={1.75} aria-hidden />
      {showTooltip && <span className={styles['tooltip']}>{descriptor.label}</span>}
    </button>
  )
}

export function ActivityBar({ part }: { part?: IPart | undefined } = {}) {
  const viewsService = useService(IViewsService)
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
      if (activeId === id) {
        viewsService.closeViewContainer(id)
      } else {
        viewsService.openViewContainer(id)
      }
    },
    [viewsService, activeId],
  )

  return (
    <nav ref={containerRef} className={styles['activitybar']} aria-label="Activity Bar">
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
