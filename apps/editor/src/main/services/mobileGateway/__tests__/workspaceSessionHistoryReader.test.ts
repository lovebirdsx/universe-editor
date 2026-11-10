import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ILogger } from '@universe-editor/platform'
import { mkTempDir } from '@universe-editor/temp-root'
import { describe, expect, it } from 'vitest'
import { workspaceIdFromUri, workspaceStoragePathFor } from '../../../storage.js'
import { WorkspaceSessionHistoryReader } from '../workspaceSessionHistoryReader.js'

const NULL_LOGGER = {
  debug: () => {},
  warn: () => {},
} as unknown as ILogger

const USER_DATA = mkTempDir('universe-history-reader-')

interface PersistedEntryOverrides {
  readonly id?: string
  readonly sessionIdOnAgent?: string
  readonly agentId?: string
  readonly title?: string
  readonly cwd?: string
  readonly authority?: string
  readonly firstPrompt?: string
  readonly createdAt?: number
  readonly lastUsedAt?: number
  readonly pinned?: boolean
  readonly sideTaskOf?: string
  readonly archived?: boolean
  readonly hasMessages?: boolean
}

function persistedEntry(overrides: PersistedEntryOverrides = {}): Record<string, unknown> {
  return {
    id: 'durable-1',
    sessionIdOnAgent: 'durable-1',
    agentId: 'claude-code',
    title: 'Fix the parser',
    cwd: '/workspace/demo',
    createdAt: 1_000,
    lastUsedAt: 2_000,
    ...overrides,
  }
}

async function writeBucket(folder: string, history: unknown): Promise<string> {
  const file = workspaceStoragePathFor(USER_DATA, workspaceIdFromUri(folder))
  await mkdir(join(USER_DATA, 'workspaces'), { recursive: true })
  await writeFile(file, JSON.stringify({ 'acp.sessionHistory': history }), 'utf8')
  return file
}

function reader(platform: 'linux' | 'win32' = 'linux'): WorkspaceSessionHistoryReader {
  return new WorkspaceSessionHistoryReader({
    userDataDir: USER_DATA,
    logger: NULL_LOGGER,
    platform,
  })
}

describe('WorkspaceSessionHistoryReader', () => {
  it('reads a local bucket and applies the bridge resumable-row rules', async () => {
    const folder = 'file:///workspace/demo'
    await writeBucket(folder, {
      schemaVersion: 6,
      entries: [
        persistedEntry({ firstPrompt: '  fix it  ', pinned: true }),
        persistedEntry({ id: 'side', sessionIdOnAgent: 'side', sideTaskOf: 'durable-1' }),
        persistedEntry({ id: 'archived', sessionIdOnAgent: 'archived', archived: true }),
        persistedEntry({ id: 'empty', sessionIdOnAgent: 'empty', hasMessages: false }),
        persistedEntry({ id: '', sessionIdOnAgent: '' }),
        persistedEntry({ id: 'foreign', sessionIdOnAgent: 'foreign', cwd: '/workspace/other' }),
        persistedEntry({ id: 'legacy-id', sessionIdOnAgent: 'legacy-id' }),
      ],
    })

    const rows = await reader('linux').read({ folder })

    expect(rows.map((row) => row.durableId)).toEqual(['durable-1', 'legacy-id'])
    expect(rows[0]).toMatchObject({
      durableId: 'durable-1',
      agentId: 'claude-code',
      title: 'Fix the parser',
      firstPrompt: 'fix it',
      cwd: '/workspace/demo',
      createdAt: 1_000,
      lastUsedAt: 2_000,
      pinned: true,
    })
  })

  it('normalizes an older id to sessionIdOnAgent', async () => {
    const folder = 'file:///workspace/demo'
    await writeBucket(folder, {
      schemaVersion: 6,
      entries: [persistedEntry({ id: 'legacy-numeric', sessionIdOnAgent: 'durable-9' })],
    })

    const rows = await reader('linux').read({ folder })
    expect(rows.map((row) => row.durableId)).toEqual(['durable-9'])
  })

  it('accepts legacy schema versions and rejects unknown ones', async () => {
    const folder = 'file:///workspace/demo'
    await writeBucket(folder, { schemaVersion: 1, entries: [persistedEntry()] })
    expect(await reader('linux').read({ folder })).toHaveLength(1)

    await writeBucket(folder, { schemaVersion: 99, entries: [persistedEntry()] })
    expect(await reader('linux').read({ folder })).toEqual([])
  })

  it('skips tombstoned entries even when an old row survives in the payload', async () => {
    const folder = 'file:///workspace/tombstones'
    await writeBucket(folder, {
      schemaVersion: 6,
      entries: [
        persistedEntry({ id: 'kept', sessionIdOnAgent: 'kept', cwd: '/workspace/tombstones' }),
        persistedEntry({
          id: 'deleted',
          sessionIdOnAgent: 'deleted',
          cwd: '/workspace/tombstones',
        }),
      ],
      deleted: ['deleted'],
    })

    const rows = await reader('linux').read({ folder })
    expect(rows.map((row) => row.durableId)).toEqual(['kept'])
  })

  it('returns an empty list for a missing bucket', async () => {
    expect(await reader('linux').read({ folder: 'file:///workspace/never-opened' })).toEqual([])
  })

  it('keeps a corrupt bucket untouched', async () => {
    const folder = 'file:///workspace/broken'
    const file = workspaceStoragePathFor(USER_DATA, workspaceIdFromUri(folder))
    await mkdir(join(USER_DATA, 'workspaces'), { recursive: true })
    await writeFile(file, '{ not json', 'utf8')

    expect(await reader('linux').read({ folder })).toEqual([])
    expect(await readFile(file, 'utf8')).toBe('{ not json')
    expect(
      (await readdir(join(USER_DATA, 'workspaces'))).some((name) => name.endsWith('.corrupt')),
    ).toBe(false)
  })

  it('derives the bucket id from the folder URI for remote workspaces', async () => {
    const folder = 'remote-ssh://devhost/home/dev/project'
    await writeBucket(folder, {
      schemaVersion: 6,
      entries: [
        persistedEntry({
          cwd: '/home/dev/project/src',
          authority: 'devhost',
          firstPrompt: 'remote work',
        }),
        // Same host, different authority spelling: the entry is foreign.
        persistedEntry({
          id: 'other-host',
          sessionIdOnAgent: 'other-host',
          authority: 'otherhost',
        }),
      ],
    })

    const rows = await reader('linux').read({ folder, authority: 'devhost' })
    expect(rows.map((row) => row.durableId)).toEqual(['durable-1'])
    expect(rows[0]?.authority).toBe('devhost')
    expect(rows[0]?.firstPrompt).toBe('remote work')

    // The folder URI itself carries the authority too.
    expect(await reader('linux').read({ folder })).toHaveLength(1)
  })
})
