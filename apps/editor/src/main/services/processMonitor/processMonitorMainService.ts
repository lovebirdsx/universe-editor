/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Process monitor main service: collects the process tree rooted at the main
 *  pid via processList.ts, overlays ProcessRoleRegistry roles, and serves
 *  snapshot / kill / text dump over IPC. Collection failures degrade to a
 *  main-only snapshot carrying errorMessage (the renderer polls, so a throw per
 *  tick would spam); the same failure is logged once.
 *--------------------------------------------------------------------------------------------*/

import {
  Disposable,
  type ILogger,
  ILoggerService,
  createNamedLogger,
} from '@universe-editor/platform'
import type {
  IProcessItem,
  IProcessMonitorService,
  IProcessSnapshot,
} from '../../../shared/ipc/processMonitorService.js'
import { processRoleRegistry, type ProcessRoleRegistry } from '../process/processRoleRegistry.js'
import { formatProcessList, listProcesses } from './processList.js'

export interface ProcessMonitorDeps {
  readonly listProcesses?: typeof listProcesses
  readonly kill?: (pid: number, signal?: NodeJS.Signals) => void
}

export class ProcessMonitorMainService extends Disposable implements IProcessMonitorService {
  declare readonly _serviceBrand: undefined

  private readonly _logger: ILogger
  private readonly _registry: ProcessRoleRegistry
  private readonly _listProcesses: typeof listProcesses
  private readonly _kill: (pid: number, signal?: NodeJS.Signals) => void
  private _errorLogged = false

  constructor(
    registry: ProcessRoleRegistry = processRoleRegistry,
    deps: ProcessMonitorDeps = {},
    @ILoggerService loggerService?: ILoggerService,
  ) {
    super()
    this._logger = createNamedLogger(loggerService, {
      id: 'processMonitor',
      name: 'Process Monitor',
    })
    this._registry = registry
    this._listProcesses = deps.listProcesses ?? listProcesses
    this._kill = deps.kill ?? ((pid, signal) => process.kill(pid, signal))
    this._register(registry.register(process.pid, { role: 'main' }))
  }

  async resolveProcesses(): Promise<IProcessSnapshot> {
    try {
      const root = await this._listProcesses(process.pid, this._registry.snapshot())
      this._errorLogged = false
      return { root }
    } catch (err) {
      if (!this._errorLogged) {
        this._errorLogged = true
        this._logger.warn(`resolveProcesses failed: ${String(err)}`)
      }
      const root: IProcessItem = {
        name: 'main',
        cmd: process.argv.join(' '),
        pid: process.pid,
        ppid: 0,
        load: 0,
        mem: process.memoryUsage().rss,
      }
      return { root, errorMessage: String(err) }
    }
  }

  async killProcess(pid: number, signal: 'SIGTERM' | 'SIGKILL' = 'SIGTERM'): Promise<void> {
    if (pid === process.pid) {
      throw new Error('refusing to kill main process')
    }
    this._logger.info(`killProcess pid=${pid} signal=${signal}`)
    this._kill(pid, signal)
  }

  async formatProcessList(): Promise<string> {
    const snapshot = await this.resolveProcesses()
    const text = formatProcessList(snapshot.root)
    return snapshot.errorMessage ? `(!) ${snapshot.errorMessage}\n${text}` : text
  }
}
