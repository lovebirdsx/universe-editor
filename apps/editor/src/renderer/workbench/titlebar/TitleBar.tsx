import { IHostService } from '@universe-editor/platform'
import { useService } from '../useService.js'
import { MenuBar } from './MenuBar.js'
import { WindowControls } from './WindowControls.js'
import styles from './TitleBar.module.css'

export function TitleBar() {
  const host = useService(IHostService)
  const isMac = host.platform === 'darwin'

  return (
    <header className={styles['titlebar']}>
      {isMac && <div className={styles['traffic-light-spacer']} />}
      <MenuBar />
      <div className={styles['title']}>Universe Editor</div>
      {!isMac && <WindowControls />}
    </header>
  )
}
