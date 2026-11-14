/*---------------------------------------------------------------------------------------------
 *  Tests for the machine-local registered-workspace list (`<userData>/triggers/workspaces.json`).
 *  Version 2 stores workspace URI strings; version 1 (bare local paths) is discarded.
 *--------------------------------------------------------------------------------------------*/

import { readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { mkTempDir } from '@universe-editor/temp-root'
import { URI, type ILogger } from '@universe-editor/platform'
import {
  TRIGGERS_WORKSPACES_FILE_NAME,
  TriggerWorkspaceRegistry,
} from '../triggerWorkspaceRegistry.js'

const dirs: string[] = []

afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined)
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

function createRegistry(dir: string): {
  registry: TriggerWorkspaceRegistry
  warns: string[]
  file: string
} {
  const { logger, warns } = createLogger()
  const file = join(dir, TRIGGERS_WORKSPACES_FILE_NAME)
  return { registry: new TriggerWorkspaceRegistry({ file, logger }), warns, file }
}

const local = (path: string): string => URI.file(path).toString()
const remote = (authority: string, path: string): string =>
  URI.from({ scheme: 'remote-ssh', authority, path }).toString()

describe('TriggerWorkspaceRegistry', () => {
  it('registers, de-duplicates and reloads workspace URIs', async () => {
    const dir = mkTempDir('ue-trigger-registry-')
    dirs.push(dir)
    const { registry, file } = createRegistry(dir)
    expect(await registry.load()).toEqual([])

    expect(await registry.register(local('X:/workspace/one'))).toBe(true)
    expect(await registry.register(local('X:/workspace/one'))).toBe(false)
    expect(await registry.register(remote('acme-host', '/work/two'))).toBe(true)
    expect(registry.list()).toEqual([local('X:/workspace/one'), remote('acme-host', '/work/two')])

    const reloaded = createRegistry(dir).registry
    expect(await reloaded.load()).toEqual([
      local('X:/workspace/one'),
      remote('acme-host', '/work/two'),
    ])

    const written = JSON.parse(await readFile(file, 'utf8')) as {
      version: number
      workspaces: string[]
    }
    expect(written.version).toBe(2)
    expect(written.workspaces).toEqual([
      local('X:/workspace/one'),
      remote('acme-host', '/work/two'),
    ])
  })

  it('refuses unsupported URIs and drops invalid persisted entries', async () => {
    const dir = mkTempDir('ue-trigger-registry-')
    dirs.push(dir)
    const { registry, warns, file } = createRegistry(dir)
    expect(await registry.register('../not-absolute')).toBe(false)
    expect(await registry.register('untitled:Untitled-1')).toBe(false)
    expect(await registry.register(remote('', '/missing-authority'))).toBe(false)
    expect(registry.list()).toEqual([])
    expect(warns.some((line) => line.includes('unsupported workspace uri'))).toBe(true)

    await writeFile(
      file,
      JSON.stringify({
        version: 2,
        workspaces: [
          '../relative',
          'X:/workspace/bare-path',
          'file://acme-host/share',
          remote('', '/missing-authority'),
          remote('acme-host', 'relative'),
          local('X:/workspace/ok'),
          42,
        ],
      }),
      'utf8',
    )
    const loaded = createRegistry(dir)
    expect(await loaded.registry.load()).toEqual([local('X:/workspace/ok')])
    expect(loaded.warns.some((line) => line.includes('invalid workspace entry'))).toBe(true)
  })

  it('discards a version 1 registry instead of migrating bare paths', async () => {
    const dir = mkTempDir('ue-trigger-registry-')
    dirs.push(dir)
    const { file } = createRegistry(dir)
    await writeFile(
      file,
      JSON.stringify({ version: 1, workspaces: ['X:/workspace/one'] }),
      'utf8',
    )
    const loaded = createRegistry(dir)
    expect(await loaded.registry.load()).toEqual([])
  })

  it('removes entries idempotently and starts empty on unreadable input', async () => {
    const dir = mkTempDir('ue-trigger-registry-')
    dirs.push(dir)
    const { registry, file } = createRegistry(dir)
    await registry.register(local('X:/workspace/one'))
    expect(await registry.remove(local('X:/workspace/one'))).toBe(true)
    expect(await registry.remove(local('X:/workspace/one'))).toBe(false)
    expect(registry.list()).toEqual([])

    await writeFile(file, 'not json', 'utf8')
    const corrupt = createRegistry(dir)
    expect(await corrupt.registry.load()).toEqual([])
    expect(corrupt.warns).toHaveLength(1)
  })
})
