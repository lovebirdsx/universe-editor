/*---------------------------------------------------------------------------------------------
 *  Tests for `<userData>/triggers/state.json` normalization: the newer per-trigger
 *  summary fields survive a reload, and hand-edited garbage / unknown enums are dropped.
 *--------------------------------------------------------------------------------------------*/

import { readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkTempDir } from '@universe-editor/temp-root'
import type { ILogger } from '@universe-editor/platform'
import {
  createEmptyTriggerStateFile,
  normalizeTriggerStateFile,
  TriggerStateStore,
} from '../triggerStateStore.js'

const dirs: string[] = []

afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    for (let attempt = 0; ; attempt++) {
      try {
        await rm(dir, { recursive: true, force: true })
        break
      } catch (err) {
        if (attempt === 4) throw err
        await new Promise((resolve) => setTimeout(resolve, 0))
      }
    }
  }
})

function createLogger(): ILogger {
  return {
    level: 0,
    onDidChangeLogLevel: () => ({ dispose: () => undefined }),
    setLevel: () => undefined,
    trace: () => undefined,
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    flush: () => undefined,
  } as unknown as ILogger
}

async function tempDir(): Promise<string> {
  const dir = mkTempDir('ue-trigger-state-')
  dirs.push(dir)
  return dir
}

describe('TriggerStateStore normalization', () => {
  it('keeps the persisted run synopsis and auto-pause flag', () => {
    const normalized = normalizeTriggerStateFile({
      version: 2,
      pausedAll: false,
      triggers: {
        'file:///X%3A/workspace\u0000triage': {
          processed: {},
          paused: true,
          autoPaused: true,
          consecutiveFailures: 5,
          baselineDone: false,
          lastRunId: 'run-1',
          lastSessionId: 'session-1',
          lastRunOutcome: 'completed',
          lastRunVerdict: 'escalate',
          lastRunSummary: 'needs a human',
          lastRunCostUsd: 0.25,
          lastRunDurationMs: 12_345,
        },
      },
      pending: [],
    })

    expect(normalized.triggers['file:///X%3A/workspace\u0000triage']).toMatchObject({
      paused: true,
      autoPaused: true,
      consecutiveFailures: 5,
      lastRunId: 'run-1',
      lastSessionId: 'session-1',
      lastRunOutcome: 'completed',
      lastRunVerdict: 'escalate',
      lastRunSummary: 'needs a human',
      lastRunCostUsd: 0.25,
      lastRunDurationMs: 12_345,
    })
  })

  it('drops unknown outcome / verdict enums instead of exposing them to the UI', () => {
    const normalized = normalizeTriggerStateFile({
      version: 2,
      pausedAll: false,
      triggers: {
        a: {
          processed: {},
          paused: false,
          consecutiveFailures: 0,
          baselineDone: false,
          lastRunOutcome: 'exploded',
          lastRunVerdict: 'maybe',
        },
      },
      pending: [],
    })
    const state = normalized.triggers['a']
    expect(state?.lastRunOutcome).toBeUndefined()
    expect(state?.lastRunVerdict).toBeUndefined()
  })

  it('treats non-boolean autoPaused and non-finite metrics as absent', () => {
    const normalized = normalizeTriggerStateFile({
      version: 2,
      pausedAll: false,
      triggers: {
        a: {
          processed: {},
          paused: false,
          autoPaused: 'yes',
          consecutiveFailures: 0,
          baselineDone: false,
          lastRunId: 42,
          lastRunCostUsd: 'free',
          lastRunDurationMs: Number.POSITIVE_INFINITY,
          lastRunSummary: 42,
        },
      },
      pending: [],
    })
    const state = normalized.triggers['a']
    expect(state?.autoPaused).toBeUndefined()
    expect(state?.lastRunId).toBeUndefined()
    expect(state?.lastRunCostUsd).toBeUndefined()
    expect(state?.lastRunDurationMs).toBeUndefined()
    expect(state?.lastRunSummary).toBeUndefined()
  })

  it('round-trips the new fields through load / flush', async () => {
    const file = join(await tempDir(), 'state.json')
    const store = new TriggerStateStore({ file, logger: createLogger(), debounceMs: 10_000 })
    const triggerKey = 'file:///X%3A/workspace\u0000triage'
    store.set({
      ...createEmptyTriggerStateFile(),
      triggers: {
        [triggerKey]: {
          processed: {},
          paused: false,
          consecutiveFailures: 0,
          baselineDone: false,
          lastRunOutcome: 'failed',
          lastRunSummary: 'boom',
        },
      },
    })
    store.dispose()

    await vi.waitFor(async () => {
      expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({
        version: 2,
        triggers: { [triggerKey]: { lastRunOutcome: 'failed' } },
      })
    })
    const reloaded = new TriggerStateStore({ file, logger: createLogger() })
    const state = await reloaded.load()
    expect(state.triggers[triggerKey]).toMatchObject({
      lastRunOutcome: 'failed',
      lastRunSummary: 'boom',
    })
  })

  it('still discards a file without version 2', () => {
    expect(normalizeTriggerStateFile({ version: 2, pausedAll: false })).toMatchObject({
      pending: [],
    })
    expect(normalizeTriggerStateFile({ triggers: {} })).toEqual(createEmptyTriggerStateFile())
  })

  it('keeps a valid file unchanged when nothing needs sanitizing', async () => {
    const file = join(await tempDir(), 'state.json')
    const valid = '11111111-2222-4333-8444-555555555555'
    await writeFile(
      file,
      JSON.stringify({
        version: 2,
        pausedAll: true,
        triggers: {},
        pending: [{ runId: valid, triggerKey: 'k', eventKey: 'poll:1', firedAt: 5 }],
      }),
      'utf8',
    )
    const store = new TriggerStateStore({ file, logger: createLogger() })
    const state = await store.load()
    expect(state.pausedAll).toBe(true)
    expect(state.pending).toHaveLength(1)
  })
})
