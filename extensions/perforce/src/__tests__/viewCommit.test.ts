import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PerforceClient } from '../client.js'
import type { ClientManager } from '../clientManager.js'
import type { GraphDescribe } from '../p4GraphParser.js'
import { buildCommitChangesPayload, openGraphFileDiff, viewCommit } from '../viewCommit.js'

const mocks = vi.hoisted(() => ({
  executeCommand: vi.fn(),
}))

vi.mock('@universe-editor/extension-api', () => ({
  commands: {
    executeCommand: mocks.executeCommand,
  },
}))

const ROOT = process.platform === 'win32' ? 'C:\\ws' : '/ws'
const DEPOT_A = '//depot/main/src/a.txt'
const DEPOT_B = '//depot/main/src/b.txt'
const LOCAL_A = join(ROOT, 'src', 'a.txt')

function details(overrides: Partial<GraphDescribe> = {}): GraphDescribe {
  return {
    id: '12345',
    author: 'alice',
    client: 'alice-ws',
    date: 1700000000,
    body: 'fix the crash\n\nmore detail',
    files: [{ depotFile: DEPOT_A, action: 'edit', rev: '3' }],
    ...overrides,
  }
}

function fakeClient(overrides: Record<string, unknown> = {}): PerforceClient {
  return {
    root: ROOT,
    getGraphChangeDetails: vi.fn(async () => ({
      ...details(),
      localPaths: new Map([[DEPOT_A, LOCAL_A]]),
    })),
    printRevision: vi.fn(async (spec: string | null) => (spec ? `content of ${spec}` : '')),
    ...overrides,
  } as unknown as PerforceClient
}

function fakeManager(client: PerforceClient | undefined) {
  return { resolveContaining: vi.fn(() => client) } as unknown as ClientManager
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.executeCommand.mockResolvedValue(undefined)
})

describe('buildCommitChangesPayload', () => {
  it('assembles the commit-changes payload from the change details', async () => {
    const client = fakeClient()
    const payload = await buildCommitChangesPayload(client, '12345')

    expect(client.getGraphChangeDetails).toHaveBeenCalledWith('12345')
    expect(payload).toMatchObject({
      providerId: 'perforce',
      title: 'Changelist 12345 — fix the crash',
      subtitle: 'alice · ' + new Date(1700000000 * 1000).toLocaleString(),
      commitRef: '12345',
      openExternalCommand: 'perforce-graph.openFileDiff',
      metadata: {
        author: 'alice',
        authorDate: 1700000000,
        message: 'fix the crash\n\nmore detail',
      },
    })
    expect(payload && 'contentCommand' in payload).toBe(false)
    expect(payload?.files).toEqual([
      {
        path: 'depot/main/src/a.txt',
        oldPath: null,
        status: 'M',
        resourcePath: LOCAL_A,
        args: { depotFile: DEPOT_A, status: 'M', rev: '3', localPath: LOCAL_A },
      },
    ])
  })

  it('keeps a null resourcePath for files outside the client view', async () => {
    const client = fakeClient({
      getGraphChangeDetails: vi.fn(async () => ({ ...details(), localPaths: new Map() })),
    })
    const payload = await buildCommitChangesPayload(client, '12345')

    expect(payload?.files[0]?.resourcePath).toBeNull()
    expect(payload?.files[0]?.args).toEqual({
      depotFile: DEPOT_A,
      status: 'M',
      rev: '3',
      localPath: null,
    })
  })

  it('maps add/delete actions to A/D statuses', async () => {
    const client = fakeClient({
      getGraphChangeDetails: vi.fn(async () => ({
        ...details({
          files: [
            { depotFile: DEPOT_A, action: 'add', rev: '1' },
            { depotFile: DEPOT_B, action: 'delete', rev: '4' },
          ],
        }),
        localPaths: new Map(),
      })),
    })
    const payload = await buildCommitChangesPayload(client, '12345')

    expect(payload?.files.map((f) => f.status)).toEqual(['A', 'D'])
  })

  it('drops the subject from the title when the description is empty', async () => {
    const client = fakeClient({
      getGraphChangeDetails: vi.fn(async () => ({
        ...details({ body: '' }),
        localPaths: new Map(),
      })),
    })
    const payload = await buildCommitChangesPayload(client, '12345')

    expect(payload?.title).toBe('Changelist 12345')
  })

  it('returns null when the change cannot be described', async () => {
    const log = vi.fn()
    const client = fakeClient({ getGraphChangeDetails: vi.fn(async () => null) })

    expect(await buildCommitChangesPayload(client, '12345', log)).toBeNull()
    expect(log).toHaveBeenCalled()
  })
})

describe('viewCommit', () => {
  it('routes the payload through _workbench.showCommitChanges', async () => {
    const client = fakeClient()
    const mgr = fakeManager(client)
    const log = vi.fn()

    await viewCommit(mgr, () => undefined, pathToFileURL(LOCAL_A).href, '12345', log)

    // The file URI is decoded to a filesystem path before client resolution.
    expect(mgr.resolveContaining).toHaveBeenCalled()
    expect(mocks.executeCommand).toHaveBeenCalledWith(
      '_workbench.showCommitChanges',
      expect.objectContaining({ providerId: 'perforce', commitRef: '12345' }),
    )
    expect(log).toHaveBeenCalled()
  })

  it('falls back to the graph client when the uri resolves to no client', async () => {
    const fallback = fakeClient()
    const mgr = fakeManager(undefined)

    await viewCommit(mgr, () => fallback, pathToFileURL(LOCAL_A).href, '12345')

    expect(fallback.getGraphChangeDetails).toHaveBeenCalledWith('12345')
    expect(mocks.executeCommand).toHaveBeenCalledWith(
      '_workbench.showCommitChanges',
      expect.objectContaining({ commitRef: '12345' }),
    )
  })

  it('accepts a bare fsPath string uri', async () => {
    const client = fakeClient()
    const mgr = fakeManager(client)

    await viewCommit(mgr, () => undefined, LOCAL_A, '12345')

    expect(mgr.resolveContaining).toHaveBeenCalledWith(LOCAL_A)
    expect(mocks.executeCommand).toHaveBeenCalledWith(
      '_workbench.showCommitChanges',
      expect.anything(),
    )
  })

  it('no-ops when the change id is missing or the details lookup fails', async () => {
    const client = fakeClient()
    const log = vi.fn()

    await viewCommit(fakeManager(client), () => undefined, undefined, undefined, log)
    expect(client.getGraphChangeDetails).not.toHaveBeenCalled()
    expect(mocks.executeCommand).not.toHaveBeenCalled()

    const failing = fakeClient({ getGraphChangeDetails: vi.fn(async () => null) })
    await viewCommit(fakeManager(failing), () => failing, undefined, '12345', log)
    expect(mocks.executeCommand).not.toHaveBeenCalled()
  })
})

describe('openGraphFileDiff', () => {
  const REQ = { depotFile: DEPOT_A, status: 'M', rev: '3', localPath: LOCAL_A }

  it('prints both revisions and opens the diff, focusing the editor by default', async () => {
    const client = fakeClient()

    await openGraphFileDiff(client, REQ)

    expect(client.printRevision).toHaveBeenCalledWith(`${DEPOT_A}#2`)
    expect(client.printRevision).toHaveBeenCalledWith(`${DEPOT_A}#3`)
    expect(mocks.executeCommand).toHaveBeenCalledWith(
      '_workbench.openDiff',
      expect.objectContaining({
        original: `content of ${DEPOT_A}#2`,
        modified: `content of ${DEPOT_A}#3`,
        pinned: false,
        preserveFocus: false,
        openableUri: pathToFileURL(LOCAL_A).href,
      }),
    )
  })

  it('passes preserveFocus through for Space-preview from the commit-changes view', async () => {
    const client = fakeClient()

    await openGraphFileDiff(client, REQ, { preserveFocus: true })

    expect(mocks.executeCommand).toHaveBeenCalledWith(
      '_workbench.openDiff',
      expect.objectContaining({ preserveFocus: true }),
    )
  })

  it('omits openableUri when the file has no local path', async () => {
    const client = fakeClient()

    await openGraphFileDiff(client, { ...REQ, localPath: null })

    const payload = mocks.executeCommand.mock.calls[0]?.[1] as Record<string, unknown>
    expect('openableUri' in payload).toBe(false)
  })
})
