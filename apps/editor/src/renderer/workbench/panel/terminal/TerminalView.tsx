import { useCallback, useEffect, useRef } from 'react'
import { Allotment } from 'allotment'
import 'allotment/dist/style.css'
import { ILayoutService, IWorkspaceService, PartId, localize } from '@universe-editor/platform'
import { ITerminalManagerService } from '../../../services/terminal/TerminalManagerService.js'
import { ITerminalXtermService } from '../../../services/terminal/TerminalXtermService.js'
import { useService, useObservable } from '../../useService.js'
import { useViewFocusable } from '../../useViewFocusable.js'
import { useWorkspaceHome } from '../../useWorkspaceHome.js'
import { TerminalInstance } from './TerminalInstance.js'
import { useResolveTerminalFile, useOpenTerminalFile } from './useTerminalOpenFile.js'
import '../../layout/allotment-theme.css'
import styles from './TerminalView.module.css'

export function TerminalView() {
  const manager = useService(ITerminalManagerService)
  const xtermService = useService(ITerminalXtermService)
  const workspaceService = useService(IWorkspaceService)
  const layoutService = useService(ILayoutService)
  const terminals = useObservable(manager.panelTerminals)
  const groups = useObservable(manager.terminalGroups)
  const activeGroupId = useObservable(manager.activeGroupId)
  const activeId = useObservable(manager.activeTerminalId)
  const panelVisible = useObservable(layoutService.visible)[PartId.Panel]

  // The view's real keyboard focus target is the active panel terminal's xterm
  // helper textarea. Without this registration the registry held only ViewBody's
  // fallback for this view id, so focusView() (Ctrl+Tab's switcher, a container-tab
  // click, the recent-targets picker) parked DOM focus on the container div — a
  // focus ring around the whole panel and keystrokes that never reached the shell.
  // `focusElement` is what `holder.focus()` drives, so both paths now agree.
  //
  // Services are read at call time rather than through render state: the getter
  // runs lazily inside focusView's poll, and a render snapshot can be stale by
  // then (the user switched instances in between). Returning null yields
  // ViewBody's fallback — which is what keeps a terminal-less empty view
  // focusable, and therefore in the Ctrl+Tab recency list. The membership check
  // mirrors what TerminalInstance's `focused` prop derives, so the element handed
  // out always belongs to the group that is on screen.
  useViewFocusable(
    'workbench.view.terminal.main',
    useCallback(() => {
      const groupId = manager.activeGroupId.get()
      const active = manager.activeTerminalId.get()
      if (groupId === null || active === null) return null
      const group = manager.terminalGroups.get().find((g) => g.id === groupId)
      if (group === undefined || !group.terminals.includes(active)) return null
      return xtermService.get(active)?.focusElement ?? null
    }, [manager, xtermService]),
  )

  // Spawn an initial terminal only on the very first mount with none open.
  // We mark didInit on the first frame regardless of outcome: once the view has
  // mounted, closing the last terminal must NOT auto-respawn one.
  // The empty check must wait for the initial workspace load: React mounts
  // before the fire-and-forget reconcileFromStorage() settles (main.tsx), so a
  // restored session briefly shows an empty list — deciding then would spawn an
  // extra terminal alongside the restored ones.
  const didInit = useRef(false)
  useEffect(() => {
    if (didInit.current) return
    didInit.current = true
    let cancelled = false
    void (async () => {
      await manager.waitForInitialLoad()
      if (cancelled) return
      if (manager.panelTerminals.get().length === 0) {
        void manager.newTerminal({ target: 'panel' })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [terminals, manager])

  const resolveFile = useResolveTerminalFile()
  const openFile = useOpenTerminalFile()
  // pty 在远端 spawn，链接里的 `~` 须展开为远端 host 的 home。
  const { home } = useWorkspaceHome()

  // 本地工作区 fsPath 是本机路径；remote 工作区 folder.fsPath 即远端 POSIX 路径（pty 在远端 spawn），同样正确。
  const cwd = workspaceService.current?.folder.fsPath ?? ''

  return (
    <div className={styles['terminal']} data-testid="view-terminal">
      <div className={styles['body']}>
        {terminals.length === 0 ? (
          <div className={styles['empty']}>{localize('terminal.empty', 'No terminals.')}</div>
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
                        focused={panelVisible && groupActive && id === activeId}
                        cwd={cwd}
                        home={home}
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
