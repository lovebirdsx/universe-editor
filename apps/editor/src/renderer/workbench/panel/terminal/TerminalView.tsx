import { useEffect, useRef } from 'react'
import { Allotment } from 'allotment'
import 'allotment/dist/style.css'
import { IWorkspaceService } from '@universe-editor/platform'
import { ITerminalManagerService } from '../../../services/terminal/TerminalManagerService.js'
import { useService, useObservable } from '../../useService.js'
import { TerminalInstance } from './TerminalInstance.js'
import { useResolveTerminalFile, useOpenTerminalFile } from './useTerminalOpenFile.js'
import '../../layout/allotment-theme.css'
import styles from './TerminalView.module.css'

export function TerminalView() {
  const manager = useService(ITerminalManagerService)
  const workspaceService = useService(IWorkspaceService)
  const terminals = useObservable(manager.panelTerminals)
  const groups = useObservable(manager.terminalGroups)
  const activeGroupId = useObservable(manager.activeGroupId)
  const activeId = useObservable(manager.activeTerminalId)

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
          groups.map((group) => {
            const groupActive = group.id === activeGroupId
            return (
              <div
                key={group.id}
                className={[styles['group'], groupActive && styles['groupVisible']]
                  .filter(Boolean)
                  .join(' ')}
                data-testid={`terminal-group-${group.id}`}
              >
                <Allotment>
                  {group.terminals.map((id) => (
                    <Allotment.Pane key={id} minSize={120}>
                      <TerminalInstance
                        id={id}
                        active={groupActive}
                        focused={groupActive && id === activeId}
                        cwd={cwd}
                        resolveFile={resolveFile}
                        openFile={openFile}
                      />
                    </Allotment.Pane>
                  ))}
                </Allotment>
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}
