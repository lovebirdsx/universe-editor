/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  ProcessExplorerEditor — VSCode-style Process Explorer. Polls
 *  IProcessMonitorService once a second (chained setTimeout so a slow
 *  collection never stacks overlapping requests) and renders the process tree
 *  as an indented flat table.
 *--------------------------------------------------------------------------------------------*/

import { useEffect, useState } from 'react'
import {
  ICommandService,
  IContextKeyService,
  IEditorInput,
  localize,
  MenuId,
} from '@universe-editor/platform'
import { ContextMenu } from '@universe-editor/workbench-ui'
import { useService } from '../useService.js'
import {
  IProcessMonitorService,
  type IProcessItem,
  type IProcessSnapshot,
} from '../../../shared/ipc/processMonitorService.js'
import { flattenProcessTree } from './processTreeModel.js'
import styles from './ProcessExplorerEditor.module.css'

interface ContextMenuState {
  readonly item: IProcessItem
  readonly x: number
  readonly y: number
}

export function ProcessExplorerEditor(_props: { input: IEditorInput }) {
  const processMonitor = useService(IProcessMonitorService)
  const commandService = useService(ICommandService)
  const contextKeyService = useService(IContextKeyService)
  const [snapshot, setSnapshot] = useState<IProcessSnapshot | null>(null)
  const [collapsed, setCollapsed] = useState<ReadonlySet<number>>(new Set())
  const [menu, setMenu] = useState<ContextMenuState | null>(null)

  useEffect(() => {
    let disposed = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = (): void => {
      void processMonitor
        .resolveProcesses()
        .then((next) => {
          if (!disposed) setSnapshot(next)
        })
        .catch(() => undefined)
        .finally(() => {
          if (!disposed) timer = setTimeout(poll, 1000)
        })
    }
    poll()
    return () => {
      disposed = true
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [processMonitor])

  const toggleCollapsed = (pid: number): void => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(pid)) next.delete(pid)
      else next.add(pid)
      return next
    })
  }

  if (!snapshot) {
    return (
      <div className={styles['root']} data-testid="process-explorer">
        <div className={styles['loading']}>
          {localize('processExplorer.loading', 'Collecting process information…')}
        </div>
      </div>
    )
  }

  const rows = flattenProcessTree(snapshot.root, collapsed)

  return (
    <div className={styles['root']} data-testid="process-explorer">
      {snapshot.errorMessage !== undefined && (
        <div className={styles['error']}>{snapshot.errorMessage}</div>
      )}
      <table className={styles['table']}>
        <thead>
          <tr>
            <th>{localize('processExplorer.columnName', 'Process Name')}</th>
            <th className={styles['num']}>{localize('processExplorer.columnCpu', 'CPU (%)')}</th>
            <th className={styles['num']}>{localize('processExplorer.columnPid', 'PID')}</th>
            <th className={styles['num']}>
              {localize('processExplorer.columnMemory', 'Memory (MB)')}
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const { item, depth, hasChildren } = row
            const isCollapsed = collapsed.has(item.pid)
            return (
              <tr
                key={item.pid}
                data-testid="process-explorer-row"
                data-pid={item.pid}
                data-role={item.role ?? ''}
                className={item.load > 90 ? styles['highLoad'] : undefined}
                onContextMenu={(e) => {
                  e.preventDefault()
                  setMenu({ item, x: e.clientX, y: e.clientY })
                }}
              >
                <td title={item.cmd}>
                  <span className={styles['name']} style={{ paddingLeft: depth * 16 }}>
                    {hasChildren ? (
                      <button
                        type="button"
                        className={styles['twistie']}
                        aria-label={
                          isCollapsed
                            ? localize('processExplorer.expand', 'Expand')
                            : localize('processExplorer.collapse', 'Collapse')
                        }
                        onClick={() => toggleCollapsed(item.pid)}
                      >
                        {isCollapsed ? '▸' : '▾'}
                      </button>
                    ) : (
                      <span className={styles['twistieSpacer']} />
                    )}
                    {item.name}
                  </span>
                </td>
                <td className={styles['num']}>{item.load.toFixed(0)}</td>
                <td className={styles['num']}>{item.pid}</td>
                <td className={styles['num']}>{(item.mem / 1024 / 1024).toFixed(0)}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
      {menu && (
        <ContextMenu
          menuId={MenuId.ProcessExplorerContext}
          anchor={{ x: menu.x, y: menu.y }}
          args={[{ pid: menu.item.pid, name: menu.item.name, cmd: menu.item.cmd }]}
          commandService={commandService}
          contextKeyService={contextKeyService}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  )
}
