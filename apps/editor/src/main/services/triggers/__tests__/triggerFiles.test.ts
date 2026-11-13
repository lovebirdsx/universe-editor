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
  triggersConfigPath,
  TRIGGERS_CONFIG_FILE_NAME,
} from '../triggersConfigFile.js'
import {
  createEmptyTriggerStateFile,
  normalizeTriggerStateFile,
  TriggerStateStore,
} from '../triggerStateStore.js'
import { pruneRunDirectories } from '../triggerMainService.js'

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
  workspace: 'X:/workspace',
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
    expect(result.value.maxConcurrentRuns).toBe(3)
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
    const file = triggersConfigPath(dir)

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
          elevatedConfirmed: 'fp',
        },
        b: 'garbage',
      },
      pending: [{ runId: 'r1', triggerId: 'a', eventKey: 'poll:1', firedAt: 5 }, { runId: 'r2' }],
    })
    expect(normalized.pausedAll).toBe(true)
    expect(normalized.triggers['a']?.processed).toEqual({ 'poll:1': { at: 10, status: 'started' } })
    expect(normalized.triggers['a']?.consecutiveFailures).toBe(2)
    expect(normalized.triggers['b']?.processed).toEqual({})
    expect(normalized.pending).toEqual([
      { runId: 'r1', triggerId: 'a', eventKey: 'poll:1', firedAt: 5 },
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

  it('is a no-op for a missing root', async () => {
    await expect(pruneRunDirectories(join(await tempDir(), 'nope'), 2)).resolves.toBeUndefined()
  })
})
