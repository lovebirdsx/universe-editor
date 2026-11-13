/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Generic JSON config store: atomic writes, external-edit watching, debounce,
 *  self-write suppression and the last-known-good fallback for broken files.
 *--------------------------------------------------------------------------------------------*/

import { readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkTempDir } from '@universe-editor/temp-root'
import type { ILogger } from '@universe-editor/platform'
import {
  JsonConfigFileStore,
  type JsonConfigFileState,
  type JsonConfigReadResult,
} from '../jsonConfigFileStore.js'

interface TestConfig {
  text: string
  count: number
  tags: string[]
}

const dirs: string[] = []
const stores: JsonConfigFileStore<TestConfig>[] = []

const warn = vi.fn()
const logger = {
  info: vi.fn(),
  warn,
  error: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn(),
} as unknown as ILogger

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(async () => {
  for (const store of stores.splice(0)) store.dispose()
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

function createDefaultConfig(): TestConfig {
  return { text: 'default', count: 0, tags: [] }
}

function serializeConfig(value: TestConfig): TestConfig {
  return { text: value.text, count: value.count, tags: [...value.tags] }
}

function isTestConfig(value: unknown): value is TestConfig {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const { text, count, tags } = value as Record<string, unknown>
  return (
    typeof text === 'string' &&
    typeof count === 'number' &&
    Array.isArray(tags) &&
    tags.every((tag) => typeof tag === 'string')
  )
}

async function readConfig(file: string): Promise<JsonConfigReadResult<TestConfig>> {
  let raw: string
  try {
    raw = await readFile(file, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' }
    return { kind: 'invalid', error: `cannot read test.json: ${toMessage(err)}` }
  }
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch (err) {
    return { kind: 'invalid', error: `cannot parse test.json: ${toMessage(err)}` }
  }
  if (!isTestConfig(value)) return { kind: 'invalid', error: 'invalid test config' }
  return { kind: 'ok', value }
}

function toMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

interface SetupOptions {
  debounceMs?: number
  selfWriteSuppressMs?: number
  initialContent?: string
  read?: (file: string) => Promise<JsonConfigReadResult<TestConfig>>
}

async function setup(
  options: SetupOptions = {},
): Promise<{ dir: string; file: string; store: JsonConfigFileStore<TestConfig> }> {
  const dir = mkTempDir('ue-json-config-store-')
  dirs.push(dir)
  const file = join(dir, 'test.json')
  if (options.initialContent !== undefined) {
    await writeFile(file, options.initialContent, 'utf8')
  }
  const store = new JsonConfigFileStore<TestConfig>({
    file,
    logger,
    debounceMs: options.debounceMs ?? 20,
    selfWriteSuppressMs: options.selfWriteSuppressMs ?? 100,
    createDefault: createDefaultConfig,
    read: options.read ?? readConfig,
    serialize: serializeConfig,
  })
  stores.push(store)
  // Let the asynchronous watcher attach before tests write to the directory.
  await new Promise((resolve) => setTimeout(resolve, 50))
  return { dir, file, store }
}

function nextExternalEvent(
  store: JsonConfigFileStore<TestConfig>,
): Promise<JsonConfigFileState<TestConfig>> {
  return new Promise((resolve) => {
    const subscription = store.onDidChangeExternal((state) => {
      subscription.dispose()
      resolve(state)
    })
  })
}

describe('JsonConfigFileStore', () => {
  it('loads defaults without creating the file', async () => {
    const { file, store } = await setup()
    await expect(store.load()).resolves.toEqual({ value: createDefaultConfig() })
    await expect(stat(file)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('uses defaults for an invalid file at startup', async () => {
    const content = '{ "count": "nope" }'
    const { file, store } = await setup({ initialContent: content })

    const state = await store.load()
    expect(state.value).toEqual(createDefaultConfig())
    expect(state.error).toContain('invalid test config')
    expect(await readFile(file, 'utf8')).toBe(content)
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('test.json is invalid; using defaults:'),
    )
  })

  it('resets to defaults when load runs after the file was broken', async () => {
    const { file, store } = await setup()
    await store.load()
    await store.update((current) => ({ ok: true, value: { ...current, count: 5 } }))
    await new Promise((resolve) => setTimeout(resolve, 150))

    await writeFile(file, 'not json', 'utf8')
    await new Promise((resolve) => setTimeout(resolve, 100))

    const state = await store.load()
    expect(state.value).toEqual(createDefaultConfig())
    expect(state.error).toContain('cannot parse test.json')
  })

  it('keeps the last valid value when an external edit is invalid', async () => {
    const { file, store } = await setup()
    await store.load()
    await store.update((current) => ({ ok: true, value: { ...current, count: 7 } }))
    await new Promise((resolve) => setTimeout(resolve, 150))

    const event = nextExternalEvent(store)
    await writeFile(file, '{ "count": "nope" }', 'utf8')

    await expect(event).resolves.toEqual({
      value: { text: 'default', count: 7, tags: [] },
      error: expect.stringContaining('invalid test config'),
    })
    expect(store.state.value.count).toBe(7)
  })

  it('does not emit when reload finds no change', async () => {
    const { store } = await setup({
      initialContent: JSON.stringify({ text: 'a', count: 1, tags: [] }),
    })
    await store.load()
    const events: JsonConfigFileState<TestConfig>[] = []
    store.onDidChangeExternal((state) => events.push(state))

    await store.reload()
    await new Promise((resolve) => setTimeout(resolve, 100))

    expect(events).toEqual([])
  })

  it('applies an external valid edit after the debounce', async () => {
    const { file, store } = await setup()
    await store.load()
    const event = nextExternalEvent(store)

    await writeFile(file, JSON.stringify({ text: 'external', count: 4, tags: ['x'] }), 'utf8')

    await expect(event).resolves.toEqual({ value: { text: 'external', count: 4, tags: ['x'] } })
    expect(store.state.value).toEqual({ text: 'external', count: 4, tags: ['x'] })
  })

  it('falls back to defaults when the file is deleted', async () => {
    const { file, store } = await setup()
    await store.load()
    await store.update((current) => ({ ok: true, value: { ...current, count: 3 } }))
    await new Promise((resolve) => setTimeout(resolve, 150))

    const event = nextExternalEvent(store)
    await rm(file)

    await expect(event).resolves.toEqual({ value: createDefaultConfig() })
  })

  it('does not emit an external event for its own writes', async () => {
    const { store } = await setup({ selfWriteSuppressMs: 100 })
    await store.load()
    const events: JsonConfigFileState<TestConfig>[] = []
    store.onDidChangeExternal((state) => events.push(state))

    await store.update((current) => ({ ok: true, value: { ...current, count: 1 } }))
    await new Promise((resolve) => setTimeout(resolve, 300))

    expect(events).toEqual([])
  })

  it('writes an update atomically with 0600 permissions', async () => {
    const { file, store } = await setup()
    await store.load()
    const events: JsonConfigFileState<TestConfig>[] = []
    store.onDidChangeExternal((state) => events.push(state))

    const result = await store.update((current) => ({
      ok: true,
      value: { ...current, count: 1 },
    }))

    expect(result.ok).toBe(true)
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({
      text: 'default',
      count: 1,
      tags: [],
    })
    if (process.platform !== 'win32') {
      expect((await stat(file)).mode & 0o777).toBe(0o600)
    }
    expect(store.state.value.count).toBe(1)
    expect(events).toEqual([])
  })

  it('rejects a patch without touching the file', async () => {
    const { file, store } = await setup()
    await store.load()

    const result = await store.update(() => ({ ok: false, errors: ['"count" must be positive'] }))

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors).toEqual(['"count" must be positive'])
    expect(store.state.value).toEqual(createDefaultConfig())
    await expect(stat(file)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('serializes concurrent updates', async () => {
    const { file, store } = await setup()
    const seen: number[] = []

    await Promise.all([
      store.update((current) => {
        seen.push(current.count)
        return { ok: true, value: { ...current, count: current.count + 1 } }
      }),
      store.update((current) => {
        seen.push(current.count)
        return { ok: true, value: { ...current, count: current.count + 1 } }
      }),
    ])

    expect(seen).toEqual([0, 1])
    expect(store.state.value.count).toBe(2)
    expect(JSON.parse(await readFile(file, 'utf8')).count).toBe(2)
  })

  it('creates defaults only when the file is missing', async () => {
    const readCalls: string[] = []
    const { file, store } = await setup({
      read: async (file) => {
        readCalls.push(file)
        return readConfig(file)
      },
    })

    await store.ensureFile()
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(createDefaultConfig())
    expect(readCalls).toHaveLength(1)

    const broken = '{ "count": 9 }'
    await writeFile(file, broken, 'utf8')
    await store.ensureFile()
    expect(await readFile(file, 'utf8')).toBe(broken)
    expect(readCalls).toHaveLength(2)
  })

  it('reports write failures without corrupting state or throwing from ensureFile', async () => {
    const dir = mkTempDir('ue-json-config-store-')
    dirs.push(dir)
    const blocker = join(dir, 'blocker')
    await writeFile(blocker, 'not a directory', 'utf8')
    const store = new JsonConfigFileStore<TestConfig>({
      file: join(blocker, 'test.json'),
      logger,
      debounceMs: 20,
      selfWriteSuppressMs: 100,
      createDefault: createDefaultConfig,
      read: async () => ({ kind: 'missing' }),
      serialize: serializeConfig,
    })
    stores.push(store)
    const before = store.state

    const result = await store.update((current) => ({
      ok: true,
      value: { ...current, count: 1 },
    }))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.join('; ')).toContain('cannot write test.json:')
    expect(store.state).toBe(before)

    await expect(store.ensureFile()).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('failed to create test.json:'))
  })

  it('stops reading and emitting after dispose', async () => {
    const readCalls: string[] = []
    const { file, store } = await setup({
      read: async (file) => {
        readCalls.push(file)
        return readConfig(file)
      },
    })
    await store.load()
    const events: JsonConfigFileState<TestConfig>[] = []
    store.onDidChangeExternal((state) => events.push(state))

    store.dispose()
    await writeFile(file, JSON.stringify({ text: 'after', count: 1, tags: [] }), 'utf8')
    await new Promise((resolve) => setTimeout(resolve, 100))

    expect(events).toEqual([])
    expect(readCalls).toHaveLength(1)
  })

  it('ignores events for other files in the directory', async () => {
    const readCalls: string[] = []
    const { dir, store } = await setup({
      read: async (file) => {
        readCalls.push(file)
        return readConfig(file)
      },
    })
    await store.load()
    const events: JsonConfigFileState<TestConfig>[] = []
    store.onDidChangeExternal((state) => events.push(state))

    await writeFile(join(dir, 'other.json'), '{}', 'utf8')
    await new Promise((resolve) => setTimeout(resolve, 100))

    expect(events).toEqual([])
    expect(readCalls).toHaveLength(1)
  })
})
