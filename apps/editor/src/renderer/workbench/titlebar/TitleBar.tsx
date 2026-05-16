import { useSyncExternalStore } from 'react'
import { IHostService, IWorkspaceService } from '@universe-editor/platform'
import { useService } from '../useService.js'
import { MenuBar } from './MenuBar.js'
import { WindowControls } from './WindowControls.js'
import styles from './TitleBar.module.css'

export function TitleBar() {
  const host = useService(IHostService)
  const workspace = useService(IWorkspaceService)
  const isMac = host.platform === 'darwin'

  const current = useSyncExternalStore(
    (onChange) => {
      const d = workspace.onDidChangeWorkspace(() => onChange())
      return () => d.dispose()
    },
    () => workspace.current,
  )

  const title = current ? `${current.name} — Universe Editor` : 'Universe Editor'

  return (
    <header className={styles['titlebar']}>
      {isMac && <div className={styles['traffic-light-spacer']} />}
      <MenuBar />
      <div className={styles['title']}>{title}</div>
      {!isMac && <WindowControls />}
    </header>
  )
}
