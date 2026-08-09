/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Process Explorer actions: open the panel, plus the row context-menu
 *  commands (kill / force kill / copy). The context-menu commands receive the
 *  clicked row as `{ pid, name, cmd }` in args[0].
 *--------------------------------------------------------------------------------------------*/

import {
  Action2,
  IEditorGroupsService,
  INotificationService,
  localize,
  localize2,
  MenuId,
  Severity,
  type ServicesAccessor,
} from '@universe-editor/platform'
import { IProcessMonitorService } from '../../shared/ipc/processMonitorService.js'
import { ProcessExplorerInput } from '../services/editor/ProcessExplorerInput.js'
import { openInLockAwareGroup } from '../services/editor/openInLockAwareGroup.js'

interface IProcessContextArg {
  readonly pid: number
  readonly name: string
  readonly cmd: string
}

export class OpenProcessExplorerAction extends Action2 {
  static readonly ID = 'workbench.action.openProcessExplorer'

  constructor() {
    super({
      id: OpenProcessExplorerAction.ID,
      title: localize2('action.openProcessExplorer.title', 'Open Process Explorer'),
      category: localize2('command.category.developer', 'Developer'),
      f1: true,
    })
  }

  override run(accessor: ServicesAccessor): void {
    openInLockAwareGroup(accessor.get(IEditorGroupsService), new ProcessExplorerInput(), {
      activate: true,
      pinned: true,
    })
  }
}

function asProcessContextArg(arg: unknown): IProcessContextArg | undefined {
  if (typeof arg !== 'object' || arg === null) return undefined
  const candidate = arg as Partial<IProcessContextArg>
  if (typeof candidate.pid !== 'number') return undefined
  return {
    pid: candidate.pid,
    name: typeof candidate.name === 'string' ? candidate.name : '',
    cmd: typeof candidate.cmd === 'string' ? candidate.cmd : '',
  }
}

async function killProcess(
  accessor: ServicesAccessor,
  arg: unknown,
  signal: 'SIGTERM' | 'SIGKILL',
): Promise<void> {
  const processMonitor = accessor.get(IProcessMonitorService)
  const notification = accessor.get(INotificationService)
  const target = asProcessContextArg(arg)
  if (!target) return
  try {
    await processMonitor.killProcess(target.pid, signal)
  } catch (err) {
    notification.notify({
      severity: Severity.Error,
      message: localize(
        'processExplorer.killFailed',
        'Failed to kill process {name} (pid {pid}): {error}',
        { name: target.name, pid: target.pid, error: (err as Error).message },
      ),
    })
  }
}

export class KillProcessAction extends Action2 {
  static readonly ID = 'processExplorer.killProcess'

  constructor() {
    super({
      id: KillProcessAction.ID,
      title: localize2('processExplorer.killProcess', 'Kill Process'),
      menu: [{ id: MenuId.ProcessExplorerContext, group: '1_kill', order: 1 }],
      f1: false,
    })
  }

  override run(accessor: ServicesAccessor, arg?: unknown): Promise<void> {
    return killProcess(accessor, arg, 'SIGTERM')
  }
}

export class ForceKillProcessAction extends Action2 {
  static readonly ID = 'processExplorer.forceKillProcess'

  constructor() {
    super({
      id: ForceKillProcessAction.ID,
      title: localize2('processExplorer.forceKillProcess', 'Force Kill Process'),
      // SIGKILL does not exist on Windows — terminate is always forceful there,
      // so this entry is only shown on macOS/Linux.
      menu: [{ id: MenuId.ProcessExplorerContext, group: '1_kill', order: 2, when: '!isWindows' }],
      f1: false,
    })
  }

  override run(accessor: ServicesAccessor, arg?: unknown): Promise<void> {
    return killProcess(accessor, arg, 'SIGKILL')
  }
}

export class CopyProcessAction extends Action2 {
  static readonly ID = 'processExplorer.copyProcess'

  constructor() {
    super({
      id: CopyProcessAction.ID,
      title: localize2('processExplorer.copyProcess', 'Copy'),
      menu: [{ id: MenuId.ProcessExplorerContext, group: '2_copy', order: 1 }],
      f1: false,
    })
  }

  override async run(_accessor: ServicesAccessor, arg?: unknown): Promise<void> {
    const target = asProcessContextArg(arg)
    if (!target) return
    await navigator.clipboard.writeText(`${target.pid}\t${target.name}\t${target.cmd}`)
  }
}

export class CopyAllProcessesAction extends Action2 {
  static readonly ID = 'processExplorer.copyAllProcesses'

  constructor() {
    super({
      id: CopyAllProcessesAction.ID,
      title: localize2('processExplorer.copyAllProcesses', 'Copy All'),
      menu: [{ id: MenuId.ProcessExplorerContext, group: '2_copy', order: 2 }],
      f1: false,
    })
  }

  override async run(accessor: ServicesAccessor): Promise<void> {
    const processMonitor = accessor.get(IProcessMonitorService)
    const text = await processMonitor.formatProcessList()
    await navigator.clipboard.writeText(text)
  }
}
