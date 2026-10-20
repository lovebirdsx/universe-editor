/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Pre-flight check for single-folder workspaces. Kept free of Electron so the
 *  classification logic is unit-testable in a plain node environment; the
 *  dialog implementation lives in electronFolderOpenGuard.ts.
 *
 *  Only `file:` folders are probed. Remote authorities are deliberately skipped:
 *  probing them would force a connection just to validate, and a transient
 *  connection failure must not be reported as "does not exist". VSCode prunes
 *  remote recents after the window is up instead (RemoteRecentFolderPruner).
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'node:fs'
import type { ILogger, URI } from '@universe-editor/platform'

export type FolderOpenProblem = 'not-found' | 'not-a-directory' | 'unavailable'

export interface FolderOpenProbeFailure {
  readonly problem: FolderOpenProblem
  readonly error?: unknown
}

export interface IWorkspaceFolderOpenGuard {
  /** Returns null when the folder may be opened. Never probes non-`file:` URIs. */
  probe(folder: URI): Promise<FolderOpenProbeFailure | null>
  /** Tells the user why the folder could not be opened. Must not throw. */
  report(folder: URI, failure: FolderOpenProbeFailure): Promise<void>
}

export type FolderStat = (path: string) => Promise<{ isDirectory(): boolean }>

export function classifyFolderProbeError(err: unknown): FolderOpenProblem {
  const code = (err as { code?: unknown } | null | undefined)?.code
  return code === 'ENOENT' || code === 'ENOTDIR' ? 'not-found' : 'unavailable'
}

export function shouldRemoveRecent(failure: FolderOpenProbeFailure): boolean {
  // Only authoritative "the folder is gone" answers prune the entry; a future
  // problem kind must default to keeping it.
  return failure.problem === 'not-found' || failure.problem === 'not-a-directory'
}

export async function probeLocalWorkspaceFolder(
  folder: URI,
  stat: FolderStat = fs.stat,
): Promise<FolderOpenProbeFailure | null> {
  if (folder.scheme !== 'file') return null
  try {
    const info = await stat(folder.fsPath)
    return info.isDirectory() ? null : { problem: 'not-a-directory' }
  } catch (err) {
    return { problem: classifyFolderProbeError(err), error: err }
  }
}

/** Shared failed-open path for the same-window and new-window entry points:
 *  drop the recent entry when the answer is authoritative, log the abort, then
 *  tell the user. Never throws. */
export async function handleFolderOpenFailure(opts: {
  action: string
  folder: URI
  failure: FolderOpenProbeFailure
  guard: IWorkspaceFolderOpenGuard
  recents: { remove(folder: URI): Promise<void> }
  logger: ILogger
}): Promise<void> {
  const key = opts.folder.toString()
  if (shouldRemoveRecent(opts.failure)) {
    try {
      await opts.recents.remove(opts.folder)
    } catch (err) {
      opts.logger.warn(`remove recent failed ${key}`, err)
    }
  }
  opts.logger.info(`${opts.action} aborted ${key} problem=${opts.failure.problem}`)
  try {
    await opts.guard.report(opts.folder, opts.failure)
  } catch (err) {
    opts.logger.warn(`report folder open failure failed ${key}`, err)
  }
}
