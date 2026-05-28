/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Persists the previous renderer session's Disposable leak report to disk
 *  so the next bootstrap can surface it. Dev/E2E only — production renderer
 *  never installs the tracker, so reportLeaks is never called.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'node:fs'
import { dirname, join } from 'node:path'
import { app } from 'electron'
import { getOriginalConsole } from '@universe-editor/platform'
import type { IDisposableLeakReport, IDisposableLeakService } from '../../../shared/ipc/services.js'

const FILE_NAME = 'last-disposable-leak.json'

export class DisposableLeakMainService implements IDisposableLeakService {
  declare readonly _serviceBrand: undefined

  private readonly _filePath: string
  private _writeChain: Promise<void> = Promise.resolve()

  constructor(filePath: string = join(app.getPath('userData'), FILE_NAME)) {
    this._filePath = filePath
  }

  async reportLeaks(report: IDisposableLeakReport): Promise<void> {
    // Surface on the terminal immediately: when the developer closes a window
    // or quits the app, the next-bootstrap notification may be hours away (or
    // never, if they don't relaunch). The terminal where `pnpm dev` is running
    // is the most reliable channel right now. Bypass the console interceptor
    // so we don't recurse through the log pipeline.
    getOriginalConsole().warn(
      `[renderer:${report.source}] ${report.count} Disposable leak(s) detected:\n${report.details}`,
    )
    const payload = JSON.stringify(report)
    this._writeChain = this._writeChain
      .catch(() => {})
      .then(async () => {
        await fs.mkdir(dirname(this._filePath), { recursive: true })
        const tmp = `${this._filePath}.tmp`
        await fs.writeFile(tmp, payload, 'utf8')
        await fs.rename(tmp, this._filePath)
      })
    return this._writeChain
  }

  async consumePendingReport(): Promise<IDisposableLeakReport | null> {
    await this._writeChain.catch(() => {})
    let raw: string
    try {
      raw = await fs.readFile(this._filePath, 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw err
    }
    try {
      await fs.unlink(this._filePath)
    } catch {
      // best-effort delete; a stale file would only cause a duplicate notification next start
    }
    try {
      const parsed = JSON.parse(raw) as IDisposableLeakReport
      if (typeof parsed?.count !== 'number' || typeof parsed?.details !== 'string') return null
      return parsed
    } catch {
      return null
    }
  }
}
