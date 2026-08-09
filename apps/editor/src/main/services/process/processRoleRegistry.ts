/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  ProcessRoleRegistry: pid → role 登记表。各子进程 spawn 点在拿到 OS pid 后
 *  登记角色（window / extension-host / acp-agent / acp-terminal / pty /
 *  utility），退出路径 dispose 登记句柄。进程管理器（processMonitor）把
 *  snapshot() 的角色信息叠加到系统进程列表上。
 *--------------------------------------------------------------------------------------------*/

import { toDisposable, type IDisposable } from '@universe-editor/platform'

export interface ProcessRoleInfo {
  readonly role: string
  readonly label?: string
}

export class ProcessRoleRegistry {
  // entry 对象身份即登记 token
  private readonly _entries = new Map<number, { info: ProcessRoleInfo }>()

  register(pid: number, info: ProcessRoleInfo): IDisposable {
    const entry = { info }
    this._entries.set(pid, entry)
    return toDisposable(() => {
      // pid 会被操作系统复用：仅当当前登记项仍是自己时才删除，
      // 防止旧句柄 dispose 误删同 pid 的新登记。
      if (this._entries.get(pid) === entry) this._entries.delete(pid)
    })
  }

  snapshot(): ReadonlyMap<number, ProcessRoleInfo> {
    const out = new Map<number, ProcessRoleInfo>()
    for (const [pid, entry] of this._entries) out.set(pid, entry.info)
    return out
  }
}

export const processRoleRegistry = new ProcessRoleRegistry()
