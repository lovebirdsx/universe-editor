/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Cross-process contract for the process monitor (the "process manager" behind
 *  the Process Explorer). Main collects the OS process tree rooted at the main
 *  pid (see main/services/processMonitor/processList.ts), overlays the roles
 *  registered in ProcessRoleRegistry, and exposes snapshot / kill / formatted
 *  text dump to renderers.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '@universe-editor/platform'

export interface IProcessItem {
  name: string
  cmd: string
  pid: number
  ppid: number
  load: number
  mem: number
  role?: string
  roleLabel?: string
  children?: IProcessItem[]
}

export interface IProcessSnapshot {
  root: IProcessItem
  /** Set when collection failed; `root` then degrades to the main process only. */
  errorMessage?: string
}

export interface IProcessMonitorService {
  readonly _serviceBrand: undefined
  resolveProcesses(): Promise<IProcessSnapshot>
  killProcess(pid: number, signal?: 'SIGTERM' | 'SIGKILL'): Promise<void>
  formatProcessList(): Promise<string>
}

export const IProcessMonitorService =
  createDecorator<IProcessMonitorService>('processMonitorService')
