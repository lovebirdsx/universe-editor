/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Diagnostics facade: hands the previous session's abnormal-exit report to the
 *  first renderer that asks (consume-once, so only one window notifies), reveals
 *  the crashpad dump directory, and powers the Report Issue flow — markdown
 *  summary + diagnostics zip (sysinfo, recent errors.jsonl, session log tails,
 *  crash-dump listing).
 *--------------------------------------------------------------------------------------------*/

import AdmZip from 'adm-zip'
import { app, shell } from 'electron'
import { promises as fs } from 'node:fs'
import { cpus, freemem, release as osRelease, totalmem } from 'node:os'
import { basename, join } from 'node:path'
import { getAppVersion } from '../../appVersion.js'
import {
  Disposable,
  type ILogger,
  ILoggerService,
  createNamedLogger,
} from '@universe-editor/platform'
import type { AbnormalExitInfo, IDiagnosticsService } from '../../../shared/ipc/services.js'
import type { AbnormalExitReport } from '../../sessionSentinel.js'
import { SESSION_DIR_RE } from '../log/logMainService.js'
import { collectSessionLogTails } from '../log/logTails.js'
import {
  aggregateErrorFingerprints,
  buildIssueMarkdown,
  type DiagnosticsExtensionEntry,
  type DiagnosticsSystemInfo,
} from './diagnosticsReport.js'

export interface DiagnosticsMainServiceOptions {
  /** <userData>/Crashes (crashpad dump root). */
  readonly crashDumpsDir: string
  /** <userData>/logs — session dirs live directly under it. */
  readonly logRoot: string
  /** Output dir for diagnostics zips (<userData>/diagnostics). */
  readonly diagnosticsDir: string
  /** dev | release | e2e */
  readonly mode: string
  /** Extension listing for the report; injected so tests stay electron-light. */
  readonly listExtensions?: () => Promise<DiagnosticsExtensionEntry[]>
  /** Process tree snapshot for the zip; injected so tests stay electron-light. */
  readonly collectProcesses?: () => Promise<string>
  /**
   * Whether exports reveal themselves via shell.showItemInFolder. Disabled in
   * E2E: popping an Explorer/Finder window mid-test serves no one.
   */
  readonly revealInShell?: boolean
  /** How many of the newest dumps get packed into the zip; injected so tests stay small. */
  readonly crashDumpMaxFiles?: number
  /** Per-dump size cap in bytes; larger dumps are listed but not packed. */
  readonly crashDumpMaxBytes?: number
}

/** How many recent log sessions feed the report and the zip. */
const REPORT_SESSION_COUNT = 2
/** Per-file tail cap for logs packed into the zip. */
const LOG_TAIL_BYTES = 512 * 1024
/** Minidumps are a few MB; anything past this is abnormal and bloats the zip. */
const CRASH_DUMP_MAX_FILES = 2
const CRASH_DUMP_MAX_BYTES = 64 * 1024 * 1024

function formatGB(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)}GB`
}

export class DiagnosticsMainService extends Disposable implements IDiagnosticsService {
  declare readonly _serviceBrand: undefined

  private readonly _logger: ILogger
  private _pendingAbnormalExit: AbnormalExitInfo | null = null

  constructor(
    private readonly _options: DiagnosticsMainServiceOptions,
    @ILoggerService loggerService?: ILoggerService,
  ) {
    super()
    this._logger = createNamedLogger(loggerService, { id: 'diagnostics', name: 'Diagnostics' })
  }

  /** Called by the bootstrap once the sentinel has been read (before any window asks). */
  setAbnormalExitReport(report: AbnormalExitReport | undefined): void {
    this._pendingAbnormalExit = report ?? null
  }

  consumeAbnormalExitReport(): Promise<AbnormalExitInfo | null> {
    const report = this._pendingAbnormalExit
    this._pendingAbnormalExit = null
    return Promise.resolve(report)
  }

  async revealCrashesFolder(): Promise<void> {
    if (this._options.revealInShell === false) return
    const dumps = await this._listCrashDumps()
    const newest = dumps[0]
    if (newest !== undefined) {
      this._logger.info(`reveal crash dump ${newest.path}`)
      shell.showItemInFolder(newest.path)
      return
    }
    const err = await shell.openPath(this._options.crashDumpsDir)
    if (err) this._logger.warn(`openPath crashedumps failed: ${err}`)
  }

  async collectIssueReport(): Promise<string> {
    const info = this._collectSystemInfo()
    const extensions = (await this._options.listExtensions?.().catch(() => [])) ?? []
    const errorTop = aggregateErrorFingerprints(await this._readRecentErrorsJsonl())
    return buildIssueMarkdown(info, extensions, errorTop)
  }

  async exportDiagnosticsZip(): Promise<string> {
    const zipPath = await this.createDiagnosticsZip()
    if (this._options.revealInShell !== false) {
      shell.showItemInFolder(zipPath)
    }
    return zipPath
  }

  async createDiagnosticsZip(): Promise<string> {
    const zip = new AdmZip()
    const markdown = await this.collectIssueReport()
    zip.addFile('sysinfo.md', Buffer.from(markdown, 'utf8'))

    const sessions = await this._recentSessionDirs()
    for (const session of sessions) {
      const dir = join(this._options.logRoot, session)
      const errors = await this._readFileIfExists(join(dir, 'errors.jsonl'))
      if (errors !== null) {
        zip.addFile(`errors-${session}.jsonl`, errors)
      }
      for (const logFile of await collectSessionLogTails(dir, LOG_TAIL_BYTES)) {
        zip.addFile(`logs/${session}/${logFile.name}`, logFile.content)
      }
    }

    const dumps = await this._listCrashDumps()
    const dumpStatus = await this._packCrashDumps(zip, dumps)
    const dumpListing = dumps.length
      ? dumps
          .map(
            (d) => `${new Date(d.mtime).toISOString()}  ${d.path}${dumpStatus.get(d.path) ?? ''}`,
          )
          .join('\n') + '\n'
      : '(no crash dumps)\n'
    zip.addFile('crash-dumps.txt', Buffer.from(dumpListing, 'utf8'))

    const processList = await this._options.collectProcesses?.().catch(() => undefined)
    zip.addFile('processes.txt', Buffer.from(processList ?? '(process list unavailable)\n', 'utf8'))

    await fs.mkdir(this._options.diagnosticsDir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const zipPath = join(this._options.diagnosticsDir, `universe-diagnostics-${stamp}.zip`)
    await zip.writeZipPromise(zipPath)
    this._logger.info(`diagnostics zip written: ${zipPath}`)
    return zipPath
  }

  private _collectSystemInfo(): DiagnosticsSystemInfo {
    const cpuList = cpus()
    const firstCpu = cpuList[0]
    const cpuDesc = firstCpu
      ? `${firstCpu.model.trim()} (${cpuList.length} × ${(firstCpu.speed / 1000).toFixed(1)}GHz)`
      : 'unknown'
    const osName =
      process.platform === 'win32' ? 'Windows' : process.platform === 'darwin' ? 'macOS' : 'Linux'
    return {
      appVersion: getAppVersion(),
      electron: process.versions.electron ?? 'unknown',
      chromium: process.versions.chrome ?? 'unknown',
      node: process.versions.node ?? 'unknown',
      os: `${osName} ${osRelease()} (${process.arch})`,
      cpus: cpuDesc,
      memory: `${formatGB(totalmem())} (free ${formatGB(freemem())})`,
      mode: this._options.mode,
      locale: app.getLocale(),
    }
  }

  /** errors.jsonl content of the most recent sessions, concatenated. */
  private async _readRecentErrorsJsonl(): Promise<string> {
    const sessions = await this._recentSessionDirs()
    const chunks: string[] = []
    for (const session of sessions) {
      const buf = await this._readFileIfExists(join(this._options.logRoot, session, 'errors.jsonl'))
      if (buf !== null) chunks.push(buf.toString('utf8'))
    }
    return chunks.join('\n')
  }

  /** Session directory names, newest first (name is a sortable timestamp). */
  private async _recentSessionDirs(): Promise<string[]> {
    let entries: string[]
    try {
      entries = await fs.readdir(this._options.logRoot)
    } catch {
      return []
    }
    return entries
      .filter((name) => SESSION_DIR_RE.test(name))
      .sort()
      .reverse()
      .slice(0, REPORT_SESSION_COUNT)
  }

  /**
   * Packs the newest dump files (up to the configured cap) into `crashes/`;
   * returns per-path status suffixes for the crash-dumps.txt listing.
   * Oversized dumps are listed but skipped; unreadable ones are skipped silently.
   */
  private async _packCrashDumps(
    zip: AdmZip,
    dumps: { path: string; mtime: number }[],
  ): Promise<Map<string, string>> {
    const status = new Map<string, string>()
    const maxFiles = this._options.crashDumpMaxFiles ?? CRASH_DUMP_MAX_FILES
    const maxBytes = this._options.crashDumpMaxBytes ?? CRASH_DUMP_MAX_BYTES
    let packed = 0
    for (const dump of dumps) {
      if (packed >= maxFiles) break
      const stat = await fs.stat(dump.path).catch(() => null)
      if (!stat) {
        this._logger.warn(`crash dump vanished, skipped: ${dump.path}`)
        continue
      }
      if (stat.size > maxBytes) {
        status.set(dump.path, ' (skipped: too large)')
        continue
      }
      const buf = await this._readFileIfExists(dump.path)
      if (buf === null) {
        this._logger.warn(`crash dump unreadable, skipped: ${dump.path}`)
        continue
      }
      zip.addFile(`crashes/${basename(dump.path)}`, buf)
      status.set(dump.path, ' (included)')
      packed++
    }
    return status
  }

  private async _listCrashDumps(): Promise<{ path: string; mtime: number }[]> {
    const found: { path: string; mtime: number }[] = []
    const walk = async (dir: string, depth: number): Promise<void> => {
      if (depth < 0) return
      let entries
      try {
        entries = await fs.readdir(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) {
          await walk(full, depth - 1)
        } else if (entry.name.toLowerCase().endsWith('.dmp')) {
          const stat = await fs.stat(full).catch(() => null)
          if (stat) found.push({ path: full, mtime: stat.mtimeMs })
        }
      }
    }
    await walk(this._options.crashDumpsDir, 3)
    found.sort((a, b) => b.mtime - a.mtime)
    return found
  }

  private _readFileIfExists(path: string): Promise<Buffer | null> {
    return fs.readFile(path).catch(() => null)
  }
}
