/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  useForeignSessionStats — cross-bucket backfill for session rows that belong to
 *  another worktree. The hydrate sweep (`session/list`) surfaces foreign sessions
 *  in the current workspace bucket, but rebuilds their history entries WITHOUT the
 *  `usage` / `accumulatedRunningMs` / `configOptions` fields — those live only in
 *  each session's own worktree storage bucket (where they were written while the
 *  session ran). We read that owning bucket directly (`IStorageService.getForWorkspaceCwd`)
 *  and return a per-session-id stat map the list uses to fill the duration / cost /
 *  model / effort columns.
 *
 *  Same cross-bucket pattern as ForeignSessionPreview, which reads the foreign
 *  config out of the owning bucket.
 *--------------------------------------------------------------------------------------------*/

import { useEffect, useMemo, useState } from 'react'
import { IStorageService, arePathsEqual, type HostPlatform } from '@universe-editor/platform'
import { useService } from '../useService.js'
import type { AcpSessionHistoryEntry } from '../../services/acp/acpSessionHistory.js'

const HISTORY_KEY = 'acp.sessionHistory'
const SCHEMA_VERSION = 1

export interface ForeignSessionStat {
  readonly accumulatedRunningMs?: number
  readonly usage?: AcpSessionHistoryEntry['usage']
  readonly configOptions?: AcpSessionHistoryEntry['configOptions']
  readonly configLabels?: AcpSessionHistoryEntry['configLabels']
  /**
   * Authoritative title read from the owning worktree's own bucket, surfaced
   * ONLY when that entry carries `aiTitle: true`. The current-workspace copy of
   * a foreign session is a hydrate cache built from `session/list`'s `summary`;
   * if the owning workspace set an AI title after the (once-per-cwd) hydrate
   * already ran — or the session's JSONL was later deleted so `session/list`
   * can no longer report it — that cache stays frozen on the first user message.
   * Reading the owning bucket recovers the real title. Left undefined when the
   * owning entry has no AI title (nothing authoritative to prefer).
   */
  readonly title?: string
}

interface PersistedHistoryShape {
  readonly schemaVersion: number
  readonly entries: readonly AcpSessionHistoryEntry[]
}

/**
 * Build a map of `sessionId → { accumulatedRunningMs, usage }` by reading the
 * duration/cost fields out of each foreign worktree's own storage bucket. Only
 * entries whose `cwd` differs from `currentCwd` are looked up; current-workspace
 * rows already carry authoritative fields in their own bucket.
 */
export function useForeignSessionStats(
  entries: readonly AcpSessionHistoryEntry[],
  currentCwd: string | undefined,
  platform: HostPlatform,
): ReadonlyMap<string, ForeignSessionStat> {
  const storage = useService(IStorageService)
  const [stats, setStats] = useState<ReadonlyMap<string, ForeignSessionStat>>(() => new Map())

  // The distinct set of owning worktree cwds we must read, sorted so the joined
  // key is stable across re-renders (avoids re-reading when only entry object
  // identity changed but the foreign-cwd set did not).
  const foreignCwds = useMemo(() => {
    const set = new Set<string>()
    for (const e of entries) {
      if (e.cwd === undefined) continue
      if (currentCwd !== undefined && arePathsEqual(e.cwd, currentCwd, platform)) continue
      set.add(e.cwd)
    }
    return [...set].sort()
  }, [entries, currentCwd, platform])

  const key = foreignCwds.join('\n')

  useEffect(() => {
    const readBucket = storage.getForWorkspaceCwd?.bind(storage)
    const cwds = key.length > 0 ? key.split('\n') : []
    if (!readBucket || cwds.length === 0) {
      setStats(new Map())
      return
    }
    let cancelled = false
    void (async () => {
      const next = new Map<string, ForeignSessionStat>()
      await Promise.all(
        cwds.map(async (cwd) => {
          const raw = await readBucket<PersistedHistoryShape>(HISTORY_KEY, cwd).catch(
            () => undefined,
          )
          if (!raw || raw.schemaVersion !== SCHEMA_VERSION || !Array.isArray(raw.entries)) return
          for (const e of raw.entries) {
            const stat: ForeignSessionStat = {
              ...(typeof e.accumulatedRunningMs === 'number'
                ? { accumulatedRunningMs: e.accumulatedRunningMs }
                : {}),
              ...(e.usage !== undefined ? { usage: e.usage } : {}),
              ...(e.configOptions !== undefined ? { configOptions: e.configOptions } : {}),
              ...(e.configLabels !== undefined ? { configLabels: e.configLabels } : {}),
              // Only an AI-generated title in the owning bucket is authoritative
              // enough to override the current bucket's hydrate cache.
              ...(e.aiTitle === true && e.title.length > 0 ? { title: e.title } : {}),
            }
            if (
              stat.accumulatedRunningMs !== undefined ||
              stat.usage !== undefined ||
              stat.configOptions !== undefined ||
              stat.configLabels !== undefined ||
              stat.title !== undefined
            ) {
              next.set(e.id, stat)
            }
          }
        }),
      )
      if (!cancelled) setStats(next)
    })()
    return () => {
      cancelled = true
    }
  }, [storage, key])

  return stats
}
