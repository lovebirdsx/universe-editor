import { useState, type ComponentType } from 'react'
import { localize } from '@universe-editor/platform'
import type { IPart } from '@universe-editor/platform'
import { usePartContainer } from '../usePartContainer.js'
import { OutputView } from './output/OutputView.js'
import { resolvePanelIcon } from './icon-map.js'
import styles from './Panel.module.css'

interface PanelTab {
  id: string
  label: string
  icon: string
  component: ComponentType
}

export function Panel({ part }: { part?: IPart | undefined } = {}) {
  const builtInTabs: PanelTab[] = [
    {
      id: 'output',
      label: localize('panel.output', 'Output'),
      icon: 'output',
      component: OutputView,
    },
  ]
  const [activeTabId, setActiveTabId] = useState(builtInTabs[0]?.id ?? '')
  const containerRef = usePartContainer(part)

  const activeTab = builtInTabs.find((t) => t.id === activeTabId)
  const ActiveComponent = activeTab?.component ?? null

  return (
    <div ref={containerRef} className={styles['panel']} data-testid="part-panel">
      <div className={styles['tabBar']} role="tablist">
        {builtInTabs.map((tab) => (
          <PanelTabButton
            key={tab.id}
            tab={tab}
            active={activeTabId === tab.id}
            onClick={() => setActiveTabId(tab.id)}
          />
        ))}
      </div>
      <div className={styles['content']}>{ActiveComponent && <ActiveComponent />}</div>
    </div>
  )
}

function PanelTabButton({
  tab,
  active,
  onClick,
}: {
  tab: PanelTab
  active: boolean
  onClick: () => void
}) {
  const Icon = resolvePanelIcon(tab.icon)

  return (
    <button
      className={`${styles['tab']} ${active ? styles['active'] : ''}`}
      role="tab"
      aria-selected={active}
      onClick={onClick}
      title={tab.label}
      data-testid={`panel-tab-${tab.id}`}
    >
      <Icon className={styles['tabIcon']} size={14} strokeWidth={1.75} aria-hidden="true" />
      <span className={styles['tabLabel']}>{tab.label}</span>
    </button>
  )
}
