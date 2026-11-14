/*---------------------------------------------------------------------------------------------
 *  Tests for the trigger file adapters: triggers.json (JSONC) + state.json + run dir retention.
 *--------------------------------------------------------------------------------------------*/

import { mkdir, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkTempDir } from '@universe-editor/temp-root'
import type { ILogger } from '@universe-editor/platform'
import {
  createEmptyTriggersConfig,
  ensureTriggersConfigFile,
  readTriggersConfigFile,
  serializeTriggersConfig,
  readMaxConcurrentRunsSetting,
  TRIGGERS_CONFIG_FILE_NAME,
  workspaceTriggersConfigPath,
} from '../triggersConfigFile.js'
import {
  createEmptyTriggerStateFile,
  normalizeTriggerStateFile,
  TriggerStateStore,
} from '../triggerStateStore.js'
import { pruneRunDirectories } from '../triggerMainService.js'
import { TRIGGER_DEFAULTS } from '../../../../shared/triggers/types.js'

const dirs: string[] = []

afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    for (let attempt = 0; ; attempt++) {
      try {
        await rm(dir, { recursive: true, force: true })
        break
      } catch (err) {
        if (attempt >= 5) throw err
        await new Promise((resolve) => setTimeout(resolve, 25))
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
  const dir = mkTempDir('ue-triggers-files-')
  dirs.push(dir)
  return dir
}

const BASE_TRIGGER = {
  id: 'weekly',
  name: 'Weekly',
  enabled: true,
  source: { type: 'schedule', cron: '0 9 * * 1', onMissed: 'skip' },
  session: { skill: 'team-weekly-digest' },
  allowedActions: [],
  concurrency: 1,
  overflow: 'queue',
}

describe('readTriggersConfigFile', () => {
  it('reads JSONC with comments and tolerates per-trigger errors', async () => {
    const dir = await tempDir()
    const file = join(dir, TRIGGERS_CONFIG_FILE_NAME)
    await writeFile(
      file,
      `// comment
      {
        "version": 1,
        "maxConcurrentRuns": 3,
        "triggers": [
          ${JSON.stringify(BASE_TRIGGER)},
          { "id": "broken" }
        ]
      }
      `,
      'utf8',
    )
    const result = await readTriggersConfigFile(file)
    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') return
    // maxConcurrentRuns is machine-local (user settings), not part of this file.
    expect(result.value).not.toHaveProperty('maxConcurrentRuns')
    expect(result.value.triggers.map((trigger) => trigger.id)).toEqual(['weekly'])
    expect(result.value.invalid.map((entry) => entry.id)).toEqual(['broken'])
  })

  it('reports a missing file and a whole-file syntax error', async () => {
    const dir = await tempDir()
    expect((await readTriggersConfigFile(join(dir, 'absent.json'))).kind).toBe('missing')

    const file = join(dir, TRIGGERS_CONFIG_FILE_NAME)
    await writeFile(file, '{ "version": 1, ', 'utf8')
    const result = await readTriggersConfigFile(file)
    expect(result.kind).toBe('invalid')
    if (result.kind === 'invalid') expect(result.error).toContain('not valid JSON')
  })

  it('rejects a non-object document and an unsupported version', async () => {
    const dir = await tempDir()
    const file = join(dir, TRIGGERS_CONFIG_FILE_NAME)
    await writeFile(file, '[]', 'utf8')
    expect((await readTriggersConfigFile(file)).kind).toBe('invalid')
    await writeFile(file, '{"version":2}', 'utf8')
    expect((await readTriggersConfigFile(file)).kind).toBe('invalid')
  })
})

describe('ensureTriggersConfigFile', () => {
  it('writes the commented example only when the file is absent', async () => {
    const dir = await tempDir()
    const file = workspaceTriggersConfigPath(dir)

    expect(await ensureTriggersConfigFile(file)).toBe(true)
    const text = await readFile(file, 'utf8')
    expect(text).toContain('// Agent 触发器配置')
    expect(text).toContain('"id": "swarm-review"')
    expect(await ensureTriggersConfigFile(file)).toBe(false)
    expect(await readFile(file, 'utf8')).toBe(text)
  })
})

describe('serializeTriggersConfig', () => {
  it('is deterministic and keeps the invalid entries for change detection', async () => {
    const dir = await tempDir()
    const file = join(dir, TRIGGERS_CONFIG_FILE_NAME)
    await writeFile(
      file,
      JSON.stringify({ version: 1, triggers: [BASE_TRIGGER, { id: 'broken' }] }),
      'utf8',
    )
    const result = await readTriggersConfigFile(file)
    if (result.kind !== 'ok') throw new Error('expected a valid config')
    expect(JSON.stringify(serializeTriggersConfig(result.value))).toBe(
      JSON.stringify(serializeTriggersConfig(result.value)),
    )
    const serialized = serializeTriggersConfig(result.value) as {
      invalid: readonly { id: string }[]
    }
    expect(serialized.invalid[0]?.id).toBe('broken')
    expect(() => createEmptyTriggersConfig()).not.toThrow()
  })
})

describe('readMaxConcurrentRunsSetting', () => {
  it('reads triggers.maxConcurrentRuns from the config dir and falls back on bad values', async () => {
    const dir = await tempDir()
    const file = join(dir, 'settings.json')
    expect(await readMaxConcurrentRunsSetting(dir)).toBe(TRIGGER_DEFAULTS.maxConcurrentRuns)

    await writeFile(file, JSON.stringify({ 'triggers.maxConcurrentRuns': 3 }), 'utf8')
    expect(await readMaxConcurrentRunsSetting(dir)).toBe(3)

    // Out-of-range / non-integer / unparsable input keeps the machine default.
    for (const bad of [0, 11, 2.5, '3']) {
      await writeFile(file, JSON.stringify({ 'triggers.maxConcurrentRuns': bad }), 'utf8')
      expect(await readMaxConcurrentRunsSetting(dir), String(bad)).toBe(
        TRIGGER_DEFAULTS.maxConcurrentRuns,
      )
    }
    await writeFile(file, '{ not json', 'utf8')
    expect(await readMaxConcurrentRunsSetting(dir)).toBe(TRIGGER_DEFAULTS.maxConcurrentRuns)
  })

  it('accepts JSONC with a trailing comma in settings.json', async () => {
    const dir = await tempDir()
    await writeFile(join(dir, 'settings.json'), '{ "triggers.maxConcurrentRuns": 4, }\n', 'utf8')
    expect(await readMaxConcurrentRunsSetting(dir)).toBe(4)
  })
})

describe('TriggerStateStore', () => {
  it('starts empty for a missing or corrupt file and warns on corrupt input', async () => {
    const dir = await tempDir()
    const { logger, warns } = createLogger()
    const store = new TriggerStateStore({ file: join(dir, 'state.json'), logger })
    expect(await store.load()).toEqual(createEmptyTriggerStateFile())

    await writeFile(join(dir, 'state.json'), 'not json', 'utf8')
    const corrupt = new TriggerStateStore({ file: join(dir, 'state.json'), logger })
    expect(await corrupt.load()).toEqual(createEmptyTriggerStateFile())
    expect(warns).toHaveLength(1)
  })

  it('drops pending records whose runId is not a UUID', async () => {
    const dir = await tempDir()
    const { logger, warns } = createLogger()
    const file = join(dir, 'state.json')
    const valid = '11111111-2222-4333-8444-555555555555'
    await writeFile(
      file,
      JSON.stringify({
        version: 1,
        pausedAll: false,
        triggers: {},
        pending: [
          { runId: valid, triggerKey: 'k-a', eventKey: 'poll:1', firedAt: 5 },
          { runId: '../../escape', triggerKey: 'k-a', eventKey: 'poll:2', firedAt: 6 },
        ],
      }),
      'utf8',
    )
    const store = new TriggerStateStore({ file, logger })
    const loaded = await store.load()
    expect(loaded.pending.map((record) => record.runId)).toEqual([valid])
    expect(warns.some((line) => line.includes('invalid runId'))).toBe(true)
  })

  it('normalizes the persisted shape and drops malformed entries', () => {
    const normalized = normalizeTriggerStateFile({
      version: 1,
      pausedAll: true,
      triggers: {
        a: {
          processed: {
            'poll:1': { at: 10, status: 'started' },
            bad: { at: 'nope', status: 'started' },
          },
          paused: true,
          consecutiveFailures: 2.9,
          backoffUntil: 50,
          lastError: 'boom',
          baselineDone: true,
          sourceFingerprint: 'poll|id|cmd|30',
          elevatedConfirmed: 'fp',
          activationConfirmed: 'afp',
        },
        b: 'garbage',
      },
      pending: [
        { runId: 'r1', triggerKey: 'k-a', eventKey: 'poll:1', firedAt: 5 },
        { runId: 'r2' },
      ],
    })
    expect(normalized.pausedAll).toBe(true)
    expect(normalized.triggers['a']?.processed).toEqual({ 'poll:1': { at: 10, status: 'started' } })
    expect(normalized.triggers['a']?.consecutiveFailures).toBe(2)
    expect(normalized.triggers['a']?.sourceFingerprint).toBe('poll|id|cmd|30')
    expect(normalized.triggers['a']?.activationConfirmed).toBe('afp')
    expect(normalized.triggers['b']?.processed).toEqual({})
    expect(normalized.pending).toEqual([
      { runId: 'r1', triggerKey: 'k-a', eventKey: 'poll:1', firedAt: 5 },
    ])
  })

  it('debounces writes and flushes on dispose', async () => {
    const dir = await tempDir()
    const file = join(dir, 'state.json')
    const { logger } = createLogger()
    const store = new TriggerStateStore({ file, logger, debounceMs: 10_000 })
    store.set({ ...createEmptyTriggerStateFile(), pausedAll: true })
    expect(await stat(file).catch(() => undefined)).toBeUndefined()

    store.dispose()
    await vi.waitFor(async () => {
      const text = await readFile(file, 'utf8')
      expect(JSON.parse(text)).toMatchObject({ pausedAll: true })
    })
  })
})

describe('pruneRunDirectories', () => {
  it('keeps the newest directories and removes the rest', async () => {
    const dir = await tempDir()
    for (let index = 0; index < 4; index++) {
      const runDir = join(dir, `run-${index}`)
      await mkdir(runDir, { recursive: true })
      await writeFile(join(runDir, 'result.json'), '{}', 'utf8')
      const stamp = new Date(Date.now() + index * 1000)
      await utimes(runDir, stamp, stamp)
    }
    await pruneRunDirectories(dir, 2)
    const remaining = (await readdir(dir)).sort()
    expect(remaining).toEqual(['run-2', 'run-3'])
  })

  it('never deletes a protected (active / queued) run directory', async () => {
    const dir = await tempDir()
    for (let index = 0; index < 4; index++) {
      const runDir = join(dir, `run-${index}`)
      await mkdir(runDir, { recursive: true })
      const stamp = new Date(Date.now() + index * 1000)
      await utimes(runDir, stamp, stamp)
    }
    await pruneRunDirectories(dir, 1, undefined, new Set(['run-0', 'run-2']))
    const remaining = (await readdir(dir)).sort()
    expect(remaining).toEqual(['run-0', 'run-2', 'run-3'])
  })

  it('is a no-op for a missing root', async () => {
    await expect(pruneRunDirectories(join(await tempDir(), 'nope'), 2)).resolves.toBeUndefined()
  })
})
