/*---------------------------------------------------------------------------------------------
 *  Tests for TriggerStateRepository: startup orphan cleanup, periodic dedupe pruning
 *  and the injected debounce clock.
 *--------------------------------------------------------------------------------------------*/

import { readFile, readdir, rm, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { mkTempDir } from '@universe-editor/temp-root'
import type { ILogger } from '@universe-editor/platform'
import type { TriggerClock, TriggerTimerHandle } from '../triggerClock.js'
import { TriggerStateRepository } from '../triggerStateRepository.js'
import { triggerKeyFor, workspaceComparisonKey } from '../triggerIdentity.js'

const START = new Date(2026, 2, 2, 8, 0, 0, 0).getTime()
const REGISTERED = 'file:///X%3A/registered'
const REMOVED = 'file:///X%3A/removed'
const dirs: string[] = []

class FakeClock implements TriggerClock {
  private _now: number
  private _seq = 0
  private readonly _timers = new Map<number, { at: number; callback: () => void }>()

  constructor(start = START) {
    this._now = start
  }

  now = (): number => this._now

  setTimeout = (callback: () => void, ms: number): TriggerTimerHandle => {
    const id = ++this._seq
    this._timers.set(id, { at: this._now + Math.max(0, ms), callback })
    return id
  }

  clearTimeout = (handle: TriggerTimerHandle): void => {
    this._timers.delete(handle as number)
  }

  get pendingTimers(): number {
    return this._timers.size
  }

  async advance(ms: number): Promise<void> {
    const target = this._now + ms
    for (;;) {
      const next = [...this._timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((left, right) => left[1].at - right[1].at)[0]
      if (next === undefined) break
      this._timers.delete(next[0])
      this._now = Math.max(this._now, next[1].at)
      next[1].callback()
      await settle()
    }
    this._now = target
  }
}

async function settle(rounds = 1): Promise<void> {
  for (let index = 0; index < rounds; index++) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    for (let attempt = 0; ; attempt++) {
      try {
        await rm(dir, { recursive: true, force: true })
        break
      } catch (err) {
        if (attempt === 4) throw err
        await settle()
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
  const dir = mkTempDir('ue-trigger-state-repo-')
  dirs.push(dir)
  return dir
}

function stateFile(path: string, triggers: Record<string, unknown>, pending: readonly unknown[]) {
  return writeFile(path, JSON.stringify({ version: 2, pausedAll: false, triggers, pending }))
}

function runtimeState(processed: Record<string, { at: number; status: string }>) {
  return { processed, paused: false, consecutiveFailures: 0, baselineDone: false }
}

describe('TriggerStateRepository startup sweep', () => {
  it('drops trigger keys and pending records of unregistered workspaces plus orphan payloads', async () => {
    const dir = await tempDir()
    const pendingDir = join(dir, 'pending')
    await mkdir(pendingDir, { recursive: true })
    const keptKey = triggerKeyFor(REGISTERED, 'kept')
    const removedKey = triggerKeyFor(REMOVED, 'gone')
    const keptRun = '11111111-2222-4333-8444-555555555555'
    const removedRun = '22222222-3333-4444-8555-666666666666'
    const orphanRun = '33333333-4444-4555-8666-777777777777'
    await stateFile(
      join(dir, 'state.json'),
      {
        [keptKey]: runtimeState({ 'poll:1': { at: START, status: 'started' } }),
        [removedKey]: runtimeState({}),
      },
      [
        { runId: keptRun, triggerKey: keptKey, eventKey: 'poll:1', firedAt: START },
        { runId: removedRun, triggerKey: removedKey, eventKey: 'poll:2', firedAt: START },
      ],
    )
    for (const runId of [keptRun, removedRun, orphanRun]) {
      await writeFile(join(pendingDir, `${runId}.json`), '{"payload":{}}')
    }

    const repo = new TriggerStateRepository({
      file: join(dir, 'state.json'),
      pendingDir,
      logger: createLogger(),
      clock: new FakeClock(),
      debounceMs: 0,
    })
    await repo.load()
    await repo.startupSweep(new Set([workspaceComparisonKey(REGISTERED)]))
    await repo.flushIfPending()

    const state = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8')) as {
      triggers: Record<string, unknown>
      pending: readonly { runId: string }[]
    }
    expect(Object.keys(state.triggers)).toEqual([keptKey])
    expect(state.pending.map((record) => record.runId)).toEqual([keptRun])
    expect((await readdir(pendingDir)).sort()).toEqual([`${keptRun}.json`])
    repo.dispose()
  })
})

describe('TriggerStateRepository pruning', () => {
  it('expires processed keys periodically even without a new write', async () => {
    const dir = await tempDir()
    const pendingDir = join(dir, 'pending')
    await mkdir(pendingDir, { recursive: true })
    const key = triggerKeyFor(REGISTERED, 'triage')
    await stateFile(
      join(dir, 'state.json'),
      { [key]: runtimeState({ 'poll:old': { at: START, status: 'started' } }) },
      [],
    )
    const clock = new FakeClock()
    const repo = new TriggerStateRepository({
      file: join(dir, 'state.json'),
      pendingDir,
      logger: createLogger(),
      clock,
      debounceMs: 0,
      ttlMs: 30 * 24 * 60 * 60 * 1000,
      pruneIntervalMs: 6 * 60 * 60_000,
    })
    await repo.load()
    // A newer key arrives 29 days later; the old one is still within the TTL.
    await clock.advance(29 * 24 * 60 * 60 * 1000)
    repo.markProcessed(key, 'poll:new', 'started')
    await repo.flushIfPending()
    expect(Object.keys(repo.stateFor(key).processed).sort()).toEqual(['poll:new', 'poll:old'])

    // Two more days: `poll:old` is past the TTL, `poll:new` is not.
    await clock.advance(2 * 24 * 60 * 60 * 1000)
    await repo.flushIfPending()
    expect(Object.keys(repo.stateFor(key).processed)).toEqual(['poll:new'])
    repo.dispose()
  })

  it('debounces writes on the injected clock', async () => {
    const dir = await tempDir()
    const pendingDir = join(dir, 'pending')
    await mkdir(pendingDir, { recursive: true })
    const file = join(dir, 'state.json')
    const clock = new FakeClock()
    const repo = new TriggerStateRepository({
      file,
      pendingDir,
      logger: createLogger(),
      clock,
      debounceMs: 200,
    })
    await repo.load()
    repo.setPausedAll(true)
    await expect(readFile(file, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    await clock.advance(200)
    await repo.flushIfPending()
    const state = JSON.parse(await readFile(file, 'utf8')) as { pausedAll: boolean }
    expect(state.pausedAll).toBe(true)
    repo.dispose()
  })

  it('does not schedule a maintenance timer while there is nothing to prune', async () => {
    const dir = await tempDir()
    const pendingDir = join(dir, 'pending')
    await mkdir(pendingDir, { recursive: true })
    const clock = new FakeClock()
    const repo = new TriggerStateRepository({
      file: join(dir, 'state.json'),
      pendingDir,
      logger: createLogger(),
      clock,
    })
    await repo.load()
    expect(clock.pendingTimers).toBe(0)
    repo.setTriggerState(triggerKeyFor(REGISTERED, 'triage'), { paused: true })
    // Only the debounced state write, no maintenance timer for an empty dedupe set.
    expect(clock.pendingTimers).toBe(1)
    await repo.flushIfPending()
    expect(clock.pendingTimers).toBe(0)
    repo.markProcessed(triggerKeyFor(REGISTERED, 'triage'), 'poll:1', 'started')
    // Debounced write + the periodic prune.
    expect(clock.pendingTimers).toBe(2)
    repo.dispose()
  })

  it('deletes fields patched with undefined and ignores an unchanged patch', async () => {
    const dir = await tempDir()
    const pendingDir = join(dir, 'pending')
    await mkdir(pendingDir, { recursive: true })
    const file = join(dir, 'state.json')
    const clock = new FakeClock()
    const repo = new TriggerStateRepository({
      file,
      pendingDir,
      logger: createLogger(),
      clock,
      debounceMs: 200,
    })
    await repo.load()
    const key = triggerKeyFor(REGISTERED, 'triage')

    repo.setTriggerState(key, { lastError: 'boom', consecutiveFailures: 2, backoffUntil: 5 })
    expect(clock.pendingTimers).toBe(1)
    repo.setTriggerState(key, { lastError: 'boom', consecutiveFailures: 2, backoffUntil: 5 })
    expect(clock.pendingTimers).toBe(1)

    repo.setTriggerState(key, {
      lastError: undefined,
      consecutiveFailures: undefined,
      backoffUntil: undefined,
    })
    const state = repo.stateFor(key)
    expect(Object.hasOwn(state, 'lastError')).toBe(false)
    expect(Object.hasOwn(state, 'consecutiveFailures')).toBe(false)
    expect(Object.hasOwn(state, 'backoffUntil')).toBe(false)

    await repo.flushIfPending()
    const persisted = JSON.parse(await readFile(file, 'utf8')) as {
      triggers: Record<string, Record<string, unknown>>
    }
    const entry = persisted.triggers[key] ?? {}
    expect(Object.hasOwn(entry, 'lastError')).toBe(false)
    expect(Object.hasOwn(entry, 'consecutiveFailures')).toBe(false)
    expect(Object.hasOwn(entry, 'backoffUntil')).toBe(false)
    repo.dispose()
  })
})
