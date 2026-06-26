import { ILayoutService, PartId, localize } from '@universe-editor/platform'
import { useObservable, useService } from '../useService.js'
import styles from './TitleBar.module.css'

function SideBarLeftIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <rect
        x="1"
        y="1.5"
        width="14"
        height="13"
        rx="1.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1"
      />
      <rect x="1" y="1.5" width="4.5" height="13" rx="1.5" fill="currentColor" />
      <line x1="5.5" y1="1.5" x2="5.5" y2="14.5" stroke="currentColor" strokeWidth="1" />
    </svg>
  )
}

function PanelBottomIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <rect
        x="1"
        y="1.5"
        width="14"
        height="13"
        rx="1.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1"
      />
      <rect x="1" y="9.5" width="14" height="5" rx="1.5" fill="currentColor" />
      <line x1="1" y1="9.5" x2="15" y2="9.5" stroke="currentColor" strokeWidth="1" />
    </svg>
  )
}

function SideBarRightIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <rect
        x="1"
        y="1.5"
        width="14"
        height="13"
        rx="1.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1"
      />
      <rect x="10.5" y="1.5" width="4.5" height="13" rx="1.5" fill="currentColor" />
      <line x1="10.5" y1="1.5" x2="10.5" y2="14.5" stroke="currentColor" strokeWidth="1" />
    </svg>
  )
}

export function LayoutControls() {
  const layoutService = useService(ILayoutService)
  const visible = useObservable(layoutService.visible)

  const sidebarVisible = visible[PartId.SideBar]
  const panelVisible = visible[PartId.Panel]
  const secondarySidebarVisible = visible[PartId.SecondarySideBar]

  return (
    <div className={styles['layout-controls']}>
      <button
        className={`${styles['layout-btn']} ${sidebarVisible ? styles['layout-btn--active'] : ''}`}
        onClick={() => layoutService.toggleVisible(PartId.SideBar)}
        title={localize(
          'layoutControls.togglePrimarySideBarWithKey',
          'Toggle Primary Side Bar (Ctrl+B)',
        )}
        aria-label={localize('action.togglePrimarySideBar.title', 'Toggle Primary Side Bar')}
        aria-pressed={sidebarVisible}
      >
        <SideBarLeftIcon />
      </button>
      <button
        className={`${styles['layout-btn']} ${panelVisible ? styles['layout-btn--active'] : ''}`}
        onClick={() => layoutService.toggleVisible(PartId.Panel)}
        title={localize('layoutControls.togglePanelWithKey', 'Toggle Panel (Ctrl+J)')}
        aria-label={localize('action.togglePanel.title', 'Toggle Panel')}
        aria-pressed={panelVisible}
      >
        <PanelBottomIcon />
      </button>
      <button
        className={`${styles['layout-btn']} ${secondarySidebarVisible ? styles['layout-btn--active'] : ''}`}
        onClick={() => layoutService.toggleVisible(PartId.SecondarySideBar)}
        title={localize(
          'layoutControls.toggleSecondarySideBarWithKey',
          'Toggle Secondary Side Bar (Ctrl+Alt+B)',
        )}
        aria-label={localize('action.toggleSecondarySideBar.title', 'Toggle Secondary Side Bar')}
        aria-pressed={secondarySidebarVisible}
      >
        <SideBarRightIcon />
      </button>
    </div>
  )
}
