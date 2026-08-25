/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Materializes remote resources into the local temp directory so the OS
 *  clipboard can carry real local paths (`localRevealFsPath` yields undefined
 *  for anything that is not local / WSL-on-Windows).
 *
 *  Layout: <temp>/universe-editor/clipboard/<sessionId>/<index>-<basename>.
 *  A new write gets a fresh session directory; the previous two are kept so a
 *  paste still in progress in the OS file manager is not deleted out from
 *  under it. Directories older than 24h are removed on startup (async — a
 *  synchronous sweep in `will-quit` would stall app exit).
 *--------------------------------------------------------------------------------------------*/

import { randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { URI } from '@universe-editor/platform'
import type { IFileService, ILogger } from '@universe-editor/platform'

export const MATERIALIZE_STALE_MS = 24 * 60 * 60 * 1000
export const MATERIALIZE_KEEP_SESSIONS = 2

export interface MaterializeEntry {
  readonly uri: URI
  readonly isDirectory: boolean
}

/** Session id: monotonic sequence + random suffix — timestamps alone can collide within a millisecond. */
export function createSessionId(seq: number, randomHex: string): string {
  return `s${seq}-${randomHex}`
}

export function randomSessionHex(): string {
  return randomBytes(6).toString('hex')
}

export interface SessionDirInfo {
  readonly name: string
  readonly mtimeMs: number
}

/** Numeric sequence embedded in `s<seq>-<hex>`; -1 for names we did not create. */
export function sessionSeq(name: string): number {
  const match = /^s(\d+)-/.exec(name)
  if (!match?.[1]) return -1
  const seq = Number(match[1])
  return Number.isSafeInteger(seq) ? seq : -1
}

/**
 * Directories to delete to keep the `keepCount` most recently modified sessions.
 * mtime alone is not enough: two writes within the same filesystem timestamp
 * tick would order arbitrarily and could delete the newer session, which is
 * exactly what keeping N sessions is meant to prevent. The monotonic `seq` in
 * the directory name breaks such ties.
 */
export function selectSessionsToDelete(
  sessions: readonly SessionDirInfo[],
  keepCount: number = MATERIALIZE_KEEP_SESSIONS,
): string[] {
  return [...sessions]
    .sort((a, b) => b.mtimeMs - a.mtimeMs || sessionSeq(b.name) - sessionSeq(a.name))
    .slice(keepCount)
    .map((s) => s.name)
}

export function isStaleSession(
  mtimeMs: number,
  nowMs: number,
  staleAfterMs: number = MATERIALIZE_STALE_MS,
): boolean {
  return nowMs - mtimeMs > staleAfterMs
}

export class ClipboardMaterializer {
  private _seq = 0
  private _sessionDir: string | undefined

  constructor(
    private readonly _fileService: IFileService,
    private readonly _rootDir: string,
    private readonly _logger?: ILogger,
  ) {}

  /** Removes session directories untouched for >24h. Fire-and-forget at startup. */
  async cleanupStale(nowMs: number = Date.now()): Promise<void> {
    try {
      const entries = await fs.readdir(this._rootDir, { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        const fullPath = join(this._rootDir, entry.name)
        try {
          const stat = await fs.stat(fullPath)
          if (isStaleSession(stat.mtimeMs, nowMs)) {
            await fs.rm(fullPath, { recursive: true, force: true })
          }
        } catch {
          // Gone already (or unreadable) — nothing to clean.
        }
      }
    } catch {
      // Root does not exist yet (first run) — nothing to clean.
    }
  }

  /**
   * Copies `entries` into a fresh session directory via IFileService.copy
   * (cross-scheme copies fall back to copyAcrossProviders; the target parent
   * is created here first, since that helper does not create parents).
   * Returns original-uri-string -> local fs path for the entries that
   * succeeded; failures are skipped and logged.
   */
  async materialize(entries: readonly MaterializeEntry[]): Promise<Map<string, string>> {
    const sessionDir = join(this._rootDir, createSessionId(++this._seq, randomSessionHex()))
    await fs.mkdir(sessionDir, { recursive: true })
    const result = new Map<string, string>()
    for (const [index, entry] of entries.entries()) {
      const name = basenameOf(entry.uri)
      const target = URI.file(join(sessionDir, `${index}-${name}`))
      try {
        await this._fileService.copy(entry.uri, target)
        result.set(entry.uri.toString(), target.fsPath)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        this._logger?.warn(`[fileClipboard] materialize '${entry.uri}' failed: ${message}`)
      }
    }
    this._sessionDir = sessionDir
    await this._prune()
    return result
  }

  /** Deletes the current session directory (best-effort). */
  async clear(): Promise<void> {
    const dir = this._sessionDir
    this._sessionDir = undefined
    if (dir) {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  private async _prune(): Promise<void> {
    let sessions: SessionDirInfo[]
    try {
      const entries = await fs.readdir(this._rootDir, { withFileTypes: true })
      sessions = []
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        try {
          const stat = await fs.stat(join(this._rootDir, entry.name))
          sessions.push({ name: entry.name, mtimeMs: stat.mtimeMs })
        } catch {
          // Ignore entries that vanished while listing.
        }
      }
    } catch {
      return
    }
    for (const name of selectSessionsToDelete(sessions)) {
      await fs
        .rm(join(this._rootDir, name), { recursive: true, force: true })
        .catch(() => undefined)
    }
  }
}

/** Last path segment of a URI, tolerating trailing slashes (directories). */
function basenameOf(uri: URI): string {
  const segments = uri.path.split('/').filter((segment) => segment.length > 0)
  return segments[segments.length - 1] ?? ''
}
