/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Tests for useForeignSessionStats — the cross-bucket backfill that fills the
 *  duration / cost columns for session rows belonging to another worktree. Those
 *  rows are rebuilt by the hydrate sweep without usage/accumulatedRunningMs; the
 *  authoritative values live only in each session's own worktree storage bucket.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElement, type ReactNode } from 'react'
import { render, cleanup, waitFor } from '@testing-library/react'
import {
  InstantiationService,
  ServiceCollection,
  IStorageService,
  type IStorageService as IStorageServiceType,
} from '@universe-editor/platform'
import { ServicesContext } from '../../useService.js'
import { useForeignSessionStats } from '../useForeignSessionStats.js'
import type { AcpSessionHistoryEntry } from '../../../services/acp/acpSessionHistory.js'

afterEach(() => cleanup())

const CURRENT_CWD = '/work/current'
const FOREIGN_CWD = '/work/foreign'

function entry(over: Partial<AcpSessionHistoryEntry> & { id: string }): AcpSessionHistoryEntry {
  return {
    agentId: 'claude',
    sessionIdOnAgent: over.id,
    title: over.id,
    createdAt: 1,
    lastUsedAt: 1,
    ...over,
  }
}

function makeStorage(
  buckets: Record<string, AcpSessionHistoryEntry[]>,
  opts: { getForWorkspaceCwd?: boolean } = {},
): { storage: IStorageServiceType; calls: string[] } {
  const calls: string[] = []
  const storage = {
    _serviceBrand: undefined,
    async get() {
      return undefined
    },
    async set() {},
    async remove() {},
    onDidChangeWorkspaceScope: () => ({ dispose() {} }),
  } as unknown as IStorageServiceType & { getForWorkspaceCwd?: unknown }
  if (opts.getForWorkspaceCwd !== false) {
    ;(storage as { getForWorkspaceCwd: unknown }).getForWorkspaceCwd = vi
      .fn()
      .mockImplementation(async (key: string, cwd: string) => {
        calls.push(`${key}@${cwd}`)
        const entries = buckets[cwd]
        if (!entries) return undefined
        return { schemaVersion: 1, entries }
      })
  }
  return { storage, calls }
}

function renderStats(
  storage: IStorageServiceType,
  entries: readonly AcpSessionHistoryEntry[],
  currentCwd: string | undefined,
) {
  const collection = new ServiceCollection([IStorageService, storage])
  const instantiation = new InstantiationService(collection)
  const captured: { value: ReturnType<typeof useForeignSessionStats> | undefined } = {
    value: undefined,
  }
  function Probe(): ReactNode {
    captured.value = useForeignSessionStats(entries, currentCwd, 'linux')
    return null
  }
  render(createElement(ServicesContext.Provider, { value: instantiation }, createElement(Probe)))
  return captured
}

describe('useForeignSessionStats', () => {
  it('backfills duration/cost from a foreign worktree bucket', async () => {
    const { storage } = makeStorage({
      [FOREIGN_CWD]: [
        entry({
          id: 's1',
          cwd: FOREIGN_CWD,
          accumulatedRunningMs: 5000,
          usage: { used: 1, size: 2, cost: { amount: 0.5, currency: 'USD' } },
        }),
      ],
    })
    const captured = renderStats(storage, [entry({ id: 's1', cwd: FOREIGN_CWD })], CURRENT_CWD)
    await waitFor(() => expect(captured.value?.get('s1')).toBeDefined())
    const stat = captured.value!.get('s1')
    expect(stat?.accumulatedRunningMs).toBe(5000)
    expect(stat?.usage?.cost?.amount).toBe(0.5)
  })

  it('backfills configOptions (model/effort) from a foreign worktree bucket', async () => {
    const { storage } = makeStorage({
      [FOREIGN_CWD]: [
        entry({
          id: 's1',
          cwd: FOREIGN_CWD,
          configOptions: { MODEL: 'claude-opus-4-8', effort: 'high' },
        }),
      ],
    })
    const captured = renderStats(storage, [entry({ id: 's1', cwd: FOREIGN_CWD })], CURRENT_CWD)
    await waitFor(() => expect(captured.value?.get('s1')).toBeDefined())
    const stat = captured.value!.get('s1')
    expect(stat?.configOptions?.['MODEL']).toBe('claude-opus-4-8')
    expect(stat?.configOptions?.['effort']).toBe('high')
  })

  it('backfills an AI-generated title from the owning worktree bucket', async () => {
    const { storage } = makeStorage({
      [FOREIGN_CWD]: [
        entry({ id: 's1', cwd: FOREIGN_CWD, title: '合并提交到 main 分支', aiTitle: true }),
      ],
    })
    // Current bucket only has the stale first-message title; the owning bucket
    // carries the authoritative AI title.
    const captured = renderStats(
      storage,
      [entry({ id: 's1', cwd: FOREIGN_CWD, title: '帮我合并 abc 到 main' })],
      CURRENT_CWD,
    )
    await waitFor(() => expect(captured.value?.get('s1')?.title).toBeDefined())
    expect(captured.value!.get('s1')?.title).toBe('合并提交到 main 分支')
  })

  it('does NOT backfill a title that is not AI-generated', async () => {
    const { storage } = makeStorage({
      [FOREIGN_CWD]: [
        // Owning bucket title is just the first prompt (aiTitle unset) — not
        // authoritative, so we must not surface it as an override.
        entry({ id: 's1', cwd: FOREIGN_CWD, title: 'first prompt text' }),
      ],
    })
    const captured = renderStats(storage, [entry({ id: 's1', cwd: FOREIGN_CWD })], CURRENT_CWD)
    // Give the async read a chance to resolve, then assert no title override.
    await waitFor(() => expect(captured.value).toBeDefined())
    // The stat map may be empty (no other fields either) — the key point is no title.
    expect(captured.value!.get('s1')?.title).toBeUndefined()
  })

  it('does not read the current workspace bucket', async () => {
    const { storage, calls } = makeStorage({
      [FOREIGN_CWD]: [entry({ id: 'f', cwd: FOREIGN_CWD, accumulatedRunningMs: 10 })],
    })
    const captured = renderStats(
      storage,
      [entry({ id: 'own', cwd: CURRENT_CWD }), entry({ id: 'f', cwd: FOREIGN_CWD })],
      CURRENT_CWD,
    )
    await waitFor(() => expect(captured.value?.get('f')).toBeDefined())
    // Only the foreign cwd was read; the current workspace cwd was skipped.
    expect(calls).toEqual([`acp.sessionHistory@${FOREIGN_CWD}`])
  })

  it('returns empty when the cross-bucket read is unavailable', async () => {
    const { storage } = makeStorage({}, { getForWorkspaceCwd: false })
    const captured = renderStats(storage, [entry({ id: 's1', cwd: FOREIGN_CWD })], CURRENT_CWD)
    // Stays empty — feature-detect short-circuits.
    await waitFor(() => expect(captured.value).toBeDefined())
    expect(captured.value!.size).toBe(0)
  })

  it('dedupes multiple foreign rows sharing one worktree to a single read', async () => {
    const { storage, calls } = makeStorage({
      [FOREIGN_CWD]: [
        entry({ id: 'a', cwd: FOREIGN_CWD, accumulatedRunningMs: 1 }),
        entry({ id: 'b', cwd: FOREIGN_CWD, accumulatedRunningMs: 2 }),
      ],
    })
    const captured = renderStats(
      storage,
      [entry({ id: 'a', cwd: FOREIGN_CWD }), entry({ id: 'b', cwd: FOREIGN_CWD })],
      CURRENT_CWD,
    )
    await waitFor(() => expect(captured.value?.get('b')).toBeDefined())
    expect(calls).toEqual([`acp.sessionHistory@${FOREIGN_CWD}`])
    expect(captured.value!.get('a')?.accumulatedRunningMs).toBe(1)
    expect(captured.value!.get('b')?.accumulatedRunningMs).toBe(2)
  })
})
