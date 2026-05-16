import { useState } from 'react'
import type { IPart } from '@universe-editor/platform'
import { usePartContainer } from '../usePartContainer.js'
import { OutputView } from './output/OutputView.js'
import styles from './Panel.module.css'

interface PanelTab {
  id: string
  label: string
  component: React.ComponentType
}

const BUILT_IN_TABS: PanelTab[] = [{ id: 'output', label: 'Output', component: OutputView }]

export function Panel({ part }: { part?: IPart | undefined } = {}) {
  const [activeTabId, setActiveTabId] = useState(BUILT_IN_TABS[0]?.id ?? '')
  const containerRef = usePartContainer(part)

  const activeTab = BUILT_IN_TABS.find((t) => t.id === activeTabId)
  const ActiveComponent = activeTab?.component ?? null

  return (
    <div ref={containerRef} className={styles['panel']}>
      <div className={styles['tabBar']} role="tablist">
        {BUILT_IN_TABS.map((tab) => (
          <button
            key={tab.id}
            className={`${styles['tab']} ${activeTabId === tab.id ? styles['active'] : ''}`}
            role="tab"
            aria-selected={activeTabId === tab.id}
            onClick={() => setActiveTabId(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div className={styles['content']}>{ActiveComponent && <ActiveComponent />}</div>
    </div>
  )
}
