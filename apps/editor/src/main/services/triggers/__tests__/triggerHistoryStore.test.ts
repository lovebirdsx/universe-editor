/*---------------------------------------------------------------------------------------------
 *  Tests for the append-only trigger run history (`history.jsonl`): newest-first
 *  reads, filtering, malformed-line tolerance, rotation and serialized writes.
 *--------------------------------------------------------------------------------------------*/

import { readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { mkTempDir } from '@universe-editor/temp-root'
import type { ILogger } from '@universe-editor/platform'
import type { TriggerRunHistoryEntry } from '../../../../shared/triggers/types.js'
import { TriggerHistoryStore } from '../triggerHistoryStore.js'

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

function createLogger(): { logger: ILogger; warns: string[] } {
  const warns: string[] = []
  const logger = {
    level: 0,
    onDidChangeLogLevel: () => ({ dispose: () => undefined }),
    setLevel: () => undefined,
    trace: () => undefined,
    debug: () => undefined,
    info: () => undefined,
    warn: (message: string) => warns.push(message),
    error: () => undefined,
    flush: () => undefined,
  } as unknown as ILogger
  return { logger, warns }
}

async function tempDir(): Promise<string> {
  const dir = mkTempDir('ue-trigger-history-')
  dirs.push(dir)
  return dir
}

function entry(overrides: Partial<TriggerRunHistoryEntry> = {}): TriggerRunHistoryEntry {
  const sequence = overrides.runId ?? 'run-1'
  return {
    runId: sequence,
    triggerKey: `file:///X%3A/workspace\u0000triage`,
    triggerId: 'triage',
    triggerName: 'Triage',
    workspace: 'file:///X%3A/workspace',
    workspaceName: 'workspace',
    startedAt: 1_000,
    endedAt: 2_000,
    outcome: 'completed',
    ...overrides,
  }
}

describe('TriggerHistoryStore', () => {
  it('appends entries and reads them newest first', async () => {
    const file = join(await tempDir(), 'history.jsonl')
    const store = new TriggerHistoryStore({ file, logger: createLogger().logger })
    await store.append(entry({ runId: 'run-1' }))
    await store.append(entry({ runId: 'run-2' }))
    await store.append(entry({ runId: 'run-3' }))

    const runs = await store.recent()
    expect(runs.map((run) => run.runId)).toEqual(['run-3', 'run-2', 'run-1'])
    expect(runs[0]).toEqual(entry({ runId: 'run-3' }))

    const lines = (await readFile(file, 'utf8')).trim().split('\n')
    expect(lines).toHaveLength(3)
  })

  it('filters by trigger key, workspace, outcome and limit', async () => {
    const file = join(await tempDir(), 'history.jsonl')
    const store = new TriggerHistoryStore({ file, logger: createLogger().logger })
    await store.append(entry({ runId: 'a', outcome: 'completed' }))
    await store.append(entry({ runId: 'b', outcome: 'failed', triggerKey: 'other' }))
    await store.append(
      entry({ runId: 'c', outcome: 'failed', workspace: 'remote-ssh://host.example.com/ws' }),
    )
    await store.append(entry({ runId: 'd', outcome: 'timeout' }))

    expect((await store.recent({ outcome: 'failed' })).map((run) => run.runId)).toEqual(['c', 'b'])
    expect((await store.recent({ triggerKey: 'other' })).map((run) => run.runId)).toEqual(['b'])
    expect(
      (await store.recent({ workspace: 'remote-ssh://host.example.com/ws' })).map(
        (run) => run.runId,
      ),
    ).toEqual(['c'])
    expect((await store.recent({ limit: 2 })).map((run) => run.runId)).toEqual(['d', 'c'])
    expect((await store.recent({ limit: 0 })).map((run) => run.runId)).toEqual(['d'])
  })

  it('skips malformed lines and unknown enum values without failing the read', async () => {
    const file = join(await tempDir(), 'history.jsonl')
    const store = new TriggerHistoryStore({ file, logger: createLogger().logger })
    const valid = entry({ runId: 'valid' })
    const lines = [
      JSON.stringify(valid),
      'not json',
      '',
      JSON.stringify({ ...valid, runId: 'bad-outcome', outcome: 'exploded' }),
      JSON.stringify({ ...valid, runId: 'bad-verdict', verdict: 'maybe' }),
      JSON.stringify({ ...valid, runId: 'no-workspace', workspace: undefined }),
      JSON.stringify({ ...valid, runId: 'bad-start', startedAt: 'yesterday' }),
      JSON.stringify({ ...valid, runId: 'bad-cost', costUsd: 'lots' }),
      JSON.stringify({ ...valid, runId: 'torn', endedAt: undefined }),
      '"just a string"',
    ]
    await writeFile(file, `${lines.join('\n')}\n`, 'utf8')

    const runs = await store.recent()
    expect(runs.map((run) => run.runId)).toEqual(['valid'])
    expect(runs[0]?.triggerName).toBe('Triage')
  })

  it('rotates to numbered generations and still reads them in order', async () => {
    const file = join(await tempDir(), 'history.jsonl')
    const store = new TriggerHistoryStore({
      file,
      logger: createLogger().logger,
      maxBytes: 320,
      maxFiles: 2,
    })
    for (let index = 1; index <= 6; index += 1) {
      await store.append(entry({ runId: `run-${index}` }))
    }

    // Generation count is capped; exact byte sizes are not part of the contract.
    expect((await stat(`${file}.1`)).isFile()).toBe(true)
    expect((await stat(`${file}.2`)).isFile()).toBe(true)
    expect(await stat(`${file}.3`).catch(() => undefined)).toBeUndefined()

    const runs = await store.recent()
    expect(runs.length).toBeGreaterThan(0)
    expect(runs.length).toBeLessThan(6)
    expect(runs[0]?.runId).toBe('run-6')
    // Whatever survived is the newest contiguous suffix, not an arbitrary mix.
    expect(runs.map((run) => run.runId)).toEqual(
      Array.from({ length: runs.length }, (_, index) => `run-${6 - index}`),
    )
  })

  it('keeps a row whose verdict summary is an empty string', async () => {
    const file = join(await tempDir(), 'history.jsonl')
    const store = new TriggerHistoryStore({ file, logger: createLogger().logger })
    await store.append(entry({ runId: 'empty', verdict: 'info', summary: '', error: '' }))
    const [run] = await store.recent()
    expect(run).toMatchObject({ runId: 'empty', summary: '', error: '' })
  })

  it('serializes concurrent appends so every line stays intact', async () => {
    const file = join(await tempDir(), 'history.jsonl')
    const store = new TriggerHistoryStore({ file, logger: createLogger().logger })
    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        store.append(entry({ runId: `run-${index}`, summary: `summary ${index}` })),
      ),
    )
    await store.flush()

    const runs = await store.recent({ limit: 500 })
    expect(runs).toHaveLength(20)
    expect(new Set(runs.map((run) => run.runId)).size).toBe(20)
    const lines = (await readFile(file, 'utf8')).trim().split('\n')
    expect(lines).toHaveLength(20)
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow()
  })

  it('returns an empty list for a missing file and survives unreadable generations', async () => {
    const dir = await tempDir()
    const { logger, warns } = createLogger()
    const store = new TriggerHistoryStore({ file: join(dir, 'history.jsonl'), logger })
    expect(await store.recent()).toEqual([])

    await writeFile(join(dir, 'history.jsonl.1'), JSON.stringify(entry({ runId: 'old' })), 'utf8')
    expect((await store.recent()).map((run) => run.runId)).toEqual(['old'])
    expect(warns).toEqual([])
  })

  it('keeps large summaries but never drops identity fields', async () => {
    const file = join(await tempDir(), 'history.jsonl')
    const store = new TriggerHistoryStore({ file, logger: createLogger().logger })
    const summary = 'x'.repeat(500)
    await store.append(entry({ summary, verdict: 'escalate', error: 'boom', costUsd: 0.5 }))
    const [run] = await store.recent()
    expect(run?.summary).toBe(summary)
    expect(run?.verdict).toBe('escalate')
    expect(run?.error).toBe('boom')
    expect(run?.costUsd).toBe(0.5)
  })

  it('does not throw when flush is called with nothing queued', async () => {
    const file = join(await tempDir(), 'history.jsonl')
    const store = new TriggerHistoryStore({ file, logger: createLogger().logger })
    await expect(store.flush()).resolves.toBeUndefined()
  })
})
