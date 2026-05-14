import { useState, useEffect, useCallback } from 'react'
import {
  ViewContainerRegistry,
  ViewContainerLocation,
  IViewsService,
} from '@universe-editor/platform'
import type { IViewContainerDescriptor } from '@universe-editor/platform'
import { useService } from '../useService.js'
import styles from './ActivityBar.module.css'

interface ActivityBarItemProps {
  descriptor: IViewContainerDescriptor
  isActive: boolean
  onClick: () => void
}

function ActivityBarItem({ descriptor, isActive, onClick }: ActivityBarItemProps) {
  const [showTooltip, setShowTooltip] = useState(false)

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
      <CodiconIcon name={descriptor.icon} />
      {showTooltip && <span className={styles['tooltip']}>{descriptor.label}</span>}
    </button>
  )
}

/** Minimal Codicon icon: renders a Unicode glyph via data attribute for CSS. */
function CodiconIcon({ name }: { name: string }) {
  return <span className={`codicon codicon-${name}`} aria-hidden />
}

export function ActivityBar() {
  const viewsService = useService(IViewsService)
  const [containers, setContainers] = useState<IViewContainerDescriptor[]>([])
  const [activeId, setActiveId] = useState<string | undefined>(undefined)

  useEffect(() => {
    const refresh = () => {
      setContainers([...ViewContainerRegistry.getViewContainers(ViewContainerLocation.SideBar)])
    }
    refresh()
    const disposable = ViewContainerRegistry.onDidRegisterViewContainer(refresh)
    return () => disposable.dispose()
  }, [])

  useEffect(() => {
    const disposable = viewsService.onDidChangeViewContainerVisibility((e) => {
      if (e.visible) setActiveId(e.containerId)
      else if (activeId === e.containerId) setActiveId(undefined)
    })
    return () => disposable.dispose()
  }, [viewsService, activeId])

  const handleClick = useCallback(
    (id: string) => {
      if (activeId === id) {
        viewsService.closeViewContainer(id)
      } else {
        viewsService.openViewContainer(id)
        setActiveId(id)
      }
    },
    [viewsService, activeId],
  )

  return (
    <nav className={styles['activitybar']} aria-label="Activity Bar">
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
