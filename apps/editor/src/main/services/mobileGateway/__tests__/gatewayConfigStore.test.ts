/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Machine-local gateway.json store: atomic writes, external-edit watching and
 *  the last-known-good fallback for broken files.
 *--------------------------------------------------------------------------------------------*/

import { readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkTempDir } from '@universe-editor/temp-root'
import type { ILogger } from '@universe-editor/platform'
import { DEFAULT_MOBILE_GATEWAY_CONFIG } from '../../../../shared/ipc/mobileGatewayService.js'
import type { MobileGatewayConfigState } from '../../../../shared/ipc/mobileGatewayService.js'
import { MobileGatewayConfigStore } from '../gatewayConfigStore.js'

const dirs: string[] = []
const stores: MobileGatewayConfigStore[] = []

afterEach(async () => {
  for (const store of stores.splice(0)) store.dispose()
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn(),
} as unknown as ILogger

async function setup(
  options: { debounceMs?: number; selfWriteSuppressMs?: number } = {},
): Promise<{ dir: string; file: string; store: MobileGatewayConfigStore }> {
  const dir = mkTempDir('ue-mobile-gateway-store-')
  dirs.push(dir)
  const file = join(dir, 'gateway.json')
  const store = new MobileGatewayConfigStore({
    file,
    logger,
    debounceMs: options.debounceMs ?? 20,
    selfWriteSuppressMs: options.selfWriteSuppressMs ?? 100,
  })
  stores.push(store)
  // Let the asynchronous watcher attach before tests write to the directory.
  await new Promise((resolve) => setTimeout(resolve, 50))
  return { dir, file, store }
}

async function nextExternalEvent(
  store: MobileGatewayConfigStore,
): Promise<MobileGatewayConfigState> {
  return new Promise((resolve) => {
    const subscription = store.onDidChangeExternal((state) => {
      subscription.dispose()
      resolve(state)
    })
  })
}

describe('MobileGatewayConfigStore', () => {
  it('loads defaults without creating the file', async () => {
    const { file, store } = await setup()
    await expect(store.load()).resolves.toEqual({
      config: DEFAULT_MOBILE_GATEWAY_CONFIG,
    })
    await expect(stat(file)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('writes a validated patch atomically with 0600 permissions', async () => {
    const { file, store } = await setup()
    await store.load()

    const result = await store.update({ enabled: true, port: 48000 })
    expect(result.ok).toBe(true)
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({
      ...DEFAULT_MOBILE_GATEWAY_CONFIG,
      enabled: true,
      port: 48000,
    })
    if (process.platform !== 'win32') {
      expect((await stat(file)).mode & 0o777).toBe(0o600)
    }
  })

  it('rejects an invalid patch without touching the file', async () => {
    const { file, store } = await setup()
    await store.load()

    const result = await store.update({ port: 0 })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.join('; ')).toContain('"port"')
    await expect(stat(file)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('serializes concurrent updates', async () => {
    const { file, store } = await setup()
    await store.load()

    await Promise.all([store.update({ port: 48001 }), store.update({ port: 48002 })])

    expect(JSON.parse(await readFile(file, 'utf8')).port).toBe(48002)
    expect(store.state.config.port).toBe(48002)
  })

  it('applies an external valid edit after the debounce', async () => {
    const { file, store } = await setup()
    await store.load()
    const event = nextExternalEvent(store)

    await writeFile(
      file,
      JSON.stringify({ ...DEFAULT_MOBILE_GATEWAY_CONFIG, enabled: true, port: 48010 }),
      'utf8',
    )

    await expect(event).resolves.toEqual({
      config: { ...DEFAULT_MOBILE_GATEWAY_CONFIG, enabled: true, port: 48010 },
    })
    expect(store.state.config.port).toBe(48010)
  })

  it('keeps the last valid config when an external edit is invalid', async () => {
    const { file, store } = await setup()
    await store.load()
    await store.update({ enabled: true, port: 48020 })
    await new Promise((resolve) => setTimeout(resolve, 150))

    const event = nextExternalEvent(store)
    await writeFile(file, '{ "port": 0 }', 'utf8')

    const state = await event
    expect(state.config.port).toBe(48020)
    expect(state.config.enabled).toBe(true)
    expect(state.error).toContain('"port"')
  })

  it('falls back to defaults when the file is deleted', async () => {
    const { file, store } = await setup()
    await store.load()
    await store.update({ enabled: true })
    await new Promise((resolve) => setTimeout(resolve, 150))

    const event = nextExternalEvent(store)
    await rm(file)

    const state = await event
    expect(state).toEqual({ config: DEFAULT_MOBILE_GATEWAY_CONFIG })
  })

  it('does not emit an external event for its own writes', async () => {
    const { store } = await setup({ selfWriteSuppressMs: 100 })
    await store.load()
    const events: MobileGatewayConfigState[] = []
    store.onDidChangeExternal((state) => events.push(state))

    await store.update({ enabled: true })
    await new Promise((resolve) => setTimeout(resolve, 300))

    expect(events).toEqual([])
  })

  it('creates defaults only when the file is missing', async () => {
    const { file, store } = await setup()
    await store.ensureFile()
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(DEFAULT_MOBILE_GATEWAY_CONFIG)

    await writeFile(file, '{ "port": 0 }', 'utf8')
    await store.ensureFile()
    expect(await readFile(file, 'utf8')).toBe('{ "port": 0 }')
  })
})
