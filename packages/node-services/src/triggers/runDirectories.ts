/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Run-directory retention: keeps the newest N per runs root (by mtime) and
 *  removes the rest. Shared by the editor's main process and the remote server —
 *  on a remote host the root is `<dataDir>/triggers/runs/<clientId>`, so pruning
 *  is naturally scoped to one editor installation.
 *--------------------------------------------------------------------------------------------*/

import { readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { ILogger } from '@universe-editor/platform'

export interface PruneRunDirectoriesOptions {
  /** Directories kept (newest by mtime); protected ids are kept on top of this. */
  readonly keep: number
  /** Run ids still active / queued / pending; never deleted even when old. */
  readonly protectedRunIds?: ReadonlySet<string>
  readonly logger?: Pick<ILogger, 'info' | 'warn'>
}

export interface PruneRunDirectoriesResult {
  /** Run ids whose directories were actually removed, newest-first iteration order. */
  readonly removed: readonly string[]
}

/** Keeps the newest `keep` run directories (by mtime) and deletes the rest. */
export async function pruneRunDirectories(
  root: string,
  options: PruneRunDirectoriesOptions,
): Promise<PruneRunDirectoriesResult> {
  const { keep, logger } = options
  const protectedRunIds = options.protectedRunIds ?? new Set<string>()
  let names: string[]
  try {
    const entries = await readdir(root, { withFileTypes: true })
    names = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
  } catch {
    return { removed: [] }
  }
  if (names.length <= keep) return { removed: [] }
  const stats = await Promise.all(
    names.map(async (name) => {
      try {
        return { name, at: (await stat(join(root, name))).mtimeMs }
      } catch {
        return undefined
      }
    }),
  )
  const ordered = stats
    .filter((entry): entry is { name: string; at: number } => entry !== undefined)
    .sort((left, right) => right.at - left.at || right.name.localeCompare(left.name))
  const doomed = ordered.filter((entry) => !protectedRunIds.has(entry.name)).slice(keep)
  const removed: string[] = []
  for (const entry of doomed) {
    try {
      await rm(join(root, entry.name), { recursive: true, force: true })
      removed.push(entry.name)
    } catch (err) {
      logger?.warn(`cannot remove old run directory ${entry.name}: ${describeError(err)}`)
    }
  }
  if (removed.length > 0) logger?.info(`removed ${removed.length} old run director(ies)`)
  return { removed }
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
