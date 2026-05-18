import { useState } from 'react'
import { localize } from '@universe-editor/platform'
import type { IPart } from '@universe-editor/platform'
import { usePartContainer } from '../usePartContainer.js'
import { OutputView } from './output/OutputView.js'
import styles from './Panel.module.css'

interface PanelTab {
  id: string
  label: string
  component: React.ComponentType
}

export function Panel({ part }: { part?: IPart | undefined } = {}) {
  const builtInTabs: PanelTab[] = [
    { id: 'output', label: localize('panel.output', 'Output'), component: OutputView },
  ]
  const [activeTabId, setActiveTabId] = useState(builtInTabs[0]?.id ?? '')
  const containerRef = usePartContainer(part)

  const activeTab = builtInTabs.find((t) => t.id === activeTabId)
  const ActiveComponent = activeTab?.component ?? null

  return (
    <div ref={containerRef} className={styles['panel']} data-testid="part-panel">
      <div className={styles['tabBar']} role="tablist">
        {builtInTabs.map((tab) => (
          <button
            key={tab.id}
            className={`${styles['tab']} ${activeTabId === tab.id ? styles['active'] : ''}`}
            role="tab"
            aria-selected={activeTabId === tab.id}
            onClick={() => setActiveTabId(tab.id)}
            data-testid={`panel-tab-${tab.id}`}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div className={styles['content']}>{ActiveComponent && <ActiveComponent />}</div>
    </div>
  )
}
