import { useEffect, useRef } from 'react'
import { IConfigurationService, IWorkspaceService } from '@universe-editor/platform'
import { ITerminalManagerService } from '../../../services/terminal/TerminalManagerService.js'
import { useService, useObservable } from '../../useService.js'
import { TerminalInstance } from './TerminalInstance.js'
import { useResolveTerminalFile, useOpenTerminalFile } from './useTerminalOpenFile.js'
import styles from './TerminalView.module.css'

export function TerminalView() {
  const manager = useService(ITerminalManagerService)
  const configService = useService(IConfigurationService)
  const workspaceService = useService(IWorkspaceService)
  const terminals = useObservable(manager.panelTerminals)
  const activeId = useObservable(manager.activeTerminalId)
  const isDark = configService.get<string>('workbench.colorTheme') !== 'light'

  // Spawn an initial terminal the first time the view mounts with none open.
  const didInit = useRef(false)
  useEffect(() => {
    if (didInit.current) return
    if (terminals.length === 0) {
      didInit.current = true
      void manager.newTerminal({ target: 'panel' })
    }
  }, [terminals, manager])

  const resolveFile = useResolveTerminalFile()
  const openFile = useOpenTerminalFile()

  const cwd = workspaceService.current?.folder.fsPath ?? ''

  return (
    <div className={styles['terminal']} data-testid="view-terminal">
      <div className={styles['body']}>
        {terminals.length === 0 ? (
          <div className={styles['empty']}>No terminals.</div>
        ) : (
          terminals.map((t) => (
            <TerminalInstance
              key={t.id}
              id={t.id}
              active={t.id === activeId}
              isDark={isDark}
              manager={manager}
              cwd={cwd}
              resolveFile={resolveFile}
              openFile={openFile}
            />
          ))
        )}
      </div>
    </div>
  )
}
