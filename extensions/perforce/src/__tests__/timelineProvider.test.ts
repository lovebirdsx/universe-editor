import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CancellationToken, TimelineItem } from '@universe-editor/extension-api'
import type { PerforceClient } from '../client.js'
import { ClientManager } from '../clientManager.js'
import type { FilelogRevision } from '../filelogParser.js'
import { createPerforceTimelineCommands, PerforceTimelineProvider } from '../timelineProvider.js'

const mocks = vi.hoisted(() => ({
  readFile: vi.fn(),
  stat: vi.fn(),
  getConfig: vi.fn(),
  executeCommand: vi.fn(),
  registerCommand: vi.fn(),
}))

vi.mock('node:fs/promises', () => ({ readFile: mocks.readFile, stat: mocks.stat }))
vi.mock('@universe-editor/extension-api', () => ({
  commands: {
    registerCommand: mocks.registerCommand,
    executeCommand: mocks.executeCommand,
  },
  workspace: {
    getConfiguration: () => ({ get: mocks.getConfig }),
  },
}))

const ROOT = process.platform === 'win32' ? 'C:\\ws' : '/ws'
const FILE = join(ROOT, 'src', 'a.txt')
const FILE_URI = pathToFileURL(FILE).href
const DEPOT = '//depot/main/src/a.txt'
const NO_TOKEN = undefined as unknown as CancellationToken

function revision(rev: string, change: string, action = 'edit'): FilelogRevision {
  return {
    rev,
    change,
    action,
    time: 1700000000 - Number(rev),
    user: 'alice',
    client: 'alice-ws',
    desc: `change ${change} subject`,
  }
}

function fakeClient(overrides: Record<string, unknown> = {}): PerforceClient {
  return {
    root: ROOT,
    fstat: vi.fn(async () => ({ depotFile: DEPOT, haveRev: '3', action: undefined })),
    getFilelog: vi.fn(async () => [] as FilelogRevision[]),
    differsFromHave: vi.fn(async () => false),
    printRevision: vi.fn(async (spec: string | null) => (spec ? `content of ${spec}` : '')),
    onDidChange: vi.fn(() => ({ dispose: () => undefined })),
    ...overrides,
  } as unknown as PerforceClient
}

function fakeManager(client: PerforceClient | undefined) {
  return { resolveContaining: vi.fn(() => client) } as unknown as ClientManager
}

function revisionsOf(items: readonly TimelineItem[]) {
  return items.filter((i) => i.contextValue === 'perforce:file:rev')
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.getConfig.mockImplementation((_key: string, def: unknown) => Promise.resolve(def))
  mocks.readFile.mockRejectedValue(new Error('ENOENT'))
  mocks.stat.mockRejectedValue(new Error('ENOENT'))
  mocks.registerCommand.mockImplementation(() => ({ dispose: () => undefined }))
  mocks.executeCommand.mockResolvedValue(undefined)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('PerforceTimelineProvider.provideTimeline', () => {
  it('resolves the depot path via fstat and pages filelog with limit+1', async () => {
    const client = fakeClient()
    const provider = new PerforceTimelineProvider(fakeManager(client))

    await provider.provideTimeline(FILE_URI, { limit: 10 }, NO_TOKEN)

    expect(client.fstat).toHaveBeenCalledWith(FILE)
    expect(client.getFilelog).toHaveBeenCalledWith(DEPOT, 11, undefined)
  })

  it('decodes the cursor into depot path + upper-bound rev and skips fstat', async () => {
    const client = fakeClient()
    const provider = new PerforceTimelineProvider(fakeManager(client))

    await provider.provideTimeline(FILE_URI, { cursor: `${DEPOT}#5`, limit: 10 }, NO_TOKEN)

    expect(client.fstat).not.toHaveBeenCalled()
    expect(client.getFilelog).toHaveBeenCalledWith(DEPOT, 11, 5)
  })

  it('returns undefined for files outside every client root', async () => {
    const provider = new PerforceTimelineProvider(fakeManager(undefined))
    expect(await provider.provideTimeline(FILE_URI, { limit: 10 }, NO_TOKEN)).toBeUndefined()
  })

  it('returns undefined when fstat finds no depot file (not p4-controlled)', async () => {
    const client = fakeClient({ fstat: vi.fn(async () => undefined) })
    const provider = new PerforceTimelineProvider(fakeManager(client))
    expect(await provider.provideTimeline(FILE_URI, { limit: 10 }, NO_TOKEN)).toBeUndefined()
    expect(client.getFilelog).not.toHaveBeenCalled()
  })

  it('returns undefined for a malformed cursor', async () => {
    const provider = new PerforceTimelineProvider(fakeManager(fakeClient()))
    expect(
      await provider.provideTimeline(FILE_URI, { cursor: 'garbage', limit: 10 }, NO_TOKEN),
    ).toBeUndefined()
  })

  it('probes with limit+1: an extra revision becomes the cursor, not a row', async () => {
    const page = [revision('6', '106'), revision('5', '105')]
    const client = fakeClient({ getFilelog: vi.fn(async () => [...page, revision('4', '104')]) })
    const provider = new PerforceTimelineProvider(fakeManager(client))

    const timeline = await provider.provideTimeline(FILE_URI, { limit: 2 }, NO_TOKEN)

    expect(timeline?.cursor).toBe(`${DEPOT}#4`)
    expect(revisionsOf(timeline?.items ?? []).map((i) => i.id)).toEqual(['106', '105'])
  })

  it('omits the cursor when the page is not full', async () => {
    const client = fakeClient({ getFilelog: vi.fn(async () => [revision('2', '102')]) })
    const provider = new PerforceTimelineProvider(fakeManager(client))

    const timeline = await provider.provideTimeline(FILE_URI, { limit: 10 }, NO_TOKEN)

    expect(timeline?.cursor).toBeUndefined()
  })

  it('builds history rows with changelist id, first-line label and openDiff command', async () => {
    const client = fakeClient({ getFilelog: vi.fn(async () => [revision('3', '103')]) })
    const provider = new PerforceTimelineProvider(fakeManager(client))

    const timeline = await provider.provideTimeline(FILE_URI, { limit: 10 }, NO_TOKEN)
    const [item] = revisionsOf(timeline?.items ?? [])

    expect(item).toMatchObject({
      id: '103',
      label: 'change 103 subject',
      timestamp: (1700000000 - 3) * 1000,
      themeIcon: 'git-commit',
      contextValue: 'perforce:file:rev',
    })
    expect(item?.command).toMatchObject({
      command: 'perforce.timeline.openDiff',
      arguments: [{ uri: FILE, depotFile: DEPOT, rev: '3', action: 'edit', change: '103' }],
    })
  })
})

describe('PerforceTimelineProvider pending entry', () => {
  it('heads the first page when the file is open (fstat action)', async () => {
    const client = fakeClient({
      fstat: vi.fn(async () => ({ depotFile: DEPOT, haveRev: '3', action: 'edit' })),
      getFilelog: vi.fn(async () => [revision('3', '103')]),
    })
    mocks.stat.mockResolvedValue({ mtimeMs: 1700000500_000 })
    const provider = new PerforceTimelineProvider(fakeManager(client))

    const timeline = await provider.provideTimeline(FILE_URI, { limit: 10 }, NO_TOKEN)

    const [first] = timeline?.items ?? []
    expect(first).toMatchObject({
      label: 'Pending Changes',
      contextValue: 'perforce:file:working',
      timestamp: 1700000500_000,
    })
    expect(first?.command).toMatchObject({
      command: 'perforce.timeline.openDiff',
      arguments: [{ uri: FILE, depotFile: DEPOT, haveRev: '3', pending: true }],
    })
    // Open files are pending by definition — no content compare needed.
    expect(client.differsFromHave).not.toHaveBeenCalled()
  })

  it('heads the first page for unopened drift (diff -se)', async () => {
    const client = fakeClient({ differsFromHave: vi.fn(async () => true) })
    const provider = new PerforceTimelineProvider(fakeManager(client))

    const timeline = await provider.provideTimeline(FILE_URI, { limit: 10 }, NO_TOKEN)

    expect(timeline?.items[0]?.contextValue).toBe('perforce:file:working')
    expect(client.differsFromHave).toHaveBeenCalledWith(FILE)
  })

  it('has no pending entry for a clean unopened file', async () => {
    const client = fakeClient()
    const provider = new PerforceTimelineProvider(fakeManager(client))

    const timeline = await provider.provideTimeline(FILE_URI, { limit: 10 }, NO_TOKEN)

    expect(timeline?.items.some((i) => i.contextValue === 'perforce:file:working')).toBe(false)
  })

  it('honours perforce.timeline.showPending = false', async () => {
    const client = fakeClient({
      fstat: vi.fn(async () => ({ depotFile: DEPOT, haveRev: '3', action: 'edit' })),
    })
    mocks.getConfig.mockImplementation((_key: string, _def: unknown) => Promise.resolve(false))
    const provider = new PerforceTimelineProvider(fakeManager(client))

    const timeline = await provider.provideTimeline(FILE_URI, { limit: 10 }, NO_TOKEN)

    expect(timeline?.items.some((i) => i.contextValue === 'perforce:file:working')).toBe(false)
  })

  it('returns only the pending entry for an open-for-add file (no depot history)', async () => {
    const client = fakeClient({
      fstat: vi.fn(async () => ({ depotFile: DEPOT, haveRev: undefined, action: 'add' })),
      getFilelog: vi.fn(async () => [] as FilelogRevision[]),
    })
    const provider = new PerforceTimelineProvider(fakeManager(client))

    const timeline = await provider.provideTimeline(FILE_URI, { limit: 10 }, NO_TOKEN)

    expect(timeline?.items).toHaveLength(1)
    expect(timeline?.items[0]?.contextValue).toBe('perforce:file:working')
  })

  it('never shows a pending entry on subsequent pages', async () => {
    const client = fakeClient({
      fstat: vi.fn(async () => ({ depotFile: DEPOT, haveRev: '3', action: 'edit' })),
    })
    const provider = new PerforceTimelineProvider(fakeManager(client))

    const timeline = await provider.provideTimeline(
      FILE_URI,
      { cursor: `${DEPOT}#5`, limit: 10 },
      NO_TOKEN,
    )

    expect(timeline?.items.some((i) => i.contextValue === 'perforce:file:working')).toBe(false)
  })
})

describe('perforce.timeline.openDiff', () => {
  function registeredHandlers(): Map<string, (arg: unknown) => Promise<unknown>> {
    const handlers = new Map<string, (arg: unknown) => Promise<unknown>>()
    mocks.registerCommand.mockImplementation((id: string, handler: (arg: unknown) => unknown) => {
      handlers.set(id, handler as (arg: unknown) => Promise<unknown>)
      return { dispose: () => undefined }
    })
    return handlers
  }

  it('diffs an edit revision against the previous revision', async () => {
    const client = fakeClient()
    const handlers = registeredHandlers()
    createPerforceTimelineCommands(fakeManager(client))

    await handlers.get('perforce.timeline.openDiff')?.({
      uri: FILE,
      depotFile: DEPOT,
      rev: '3',
      action: 'edit',
      change: '103',
    })

    expect(client.printRevision).toHaveBeenCalledWith(`${DEPOT}#2`)
    expect(client.printRevision).toHaveBeenCalledWith(`${DEPOT}#3`)
    expect(mocks.executeCommand).toHaveBeenCalledWith(
      '_workbench.openDiff',
      expect.objectContaining({
        title: 'a.txt (changelist 103)',
        original: `content of ${DEPOT}#2`,
        modified: `content of ${DEPOT}#3`,
      }),
    )
    const payload = mocks.executeCommand.mock.calls.find((c) => c[0] === '_workbench.openDiff')?.[1]
    expect(payload).not.toHaveProperty('liveModified')
  })

  it('diffs an add revision against an empty left side', async () => {
    const client = fakeClient()
    const handlers = registeredHandlers()
    createPerforceTimelineCommands(fakeManager(client))

    await handlers.get('perforce.timeline.openDiff')?.({
      uri: FILE,
      depotFile: DEPOT,
      rev: '1',
      action: 'add',
      change: '100',
    })

    expect(client.printRevision).toHaveBeenCalledWith(null)
    expect(client.printRevision).toHaveBeenCalledWith(`${DEPOT}#1`)
  })

  it('diffs a delete revision against an empty right side', async () => {
    const client = fakeClient()
    const handlers = registeredHandlers()
    createPerforceTimelineCommands(fakeManager(client))

    await handlers.get('perforce.timeline.openDiff')?.({
      uri: FILE,
      depotFile: DEPOT,
      rev: '3',
      action: 'delete',
      change: '103',
    })

    expect(client.printRevision).toHaveBeenCalledWith(`${DEPOT}#2`)
    expect(client.printRevision).toHaveBeenCalledWith(null)
  })

  it('diffs the pending entry against the have revision, live on the right', async () => {
    const client = fakeClient()
    mocks.readFile.mockResolvedValue('working tree content')
    const handlers = registeredHandlers()
    createPerforceTimelineCommands(fakeManager(client))

    await handlers.get('perforce.timeline.openDiff')?.({
      uri: FILE,
      depotFile: DEPOT,
      haveRev: '3',
      pending: true,
    })

    expect(client.printRevision).toHaveBeenCalledWith(`${DEPOT}#3`)
    expect(mocks.readFile).toHaveBeenCalledWith(FILE, 'utf8')
    expect(mocks.executeCommand).toHaveBeenCalledWith(
      '_workbench.openDiff',
      expect.objectContaining({
        title: 'a.txt (Working Tree)',
        original: `content of ${DEPOT}#3`,
        modified: 'working tree content',
        liveModified: true,
      }),
    )
  })

  it('diffs an open-for-add pending entry against an empty left side', async () => {
    const client = fakeClient()
    mocks.readFile.mockResolvedValue('new file content')
    const handlers = registeredHandlers()
    createPerforceTimelineCommands(fakeManager(client))

    await handlers.get('perforce.timeline.openDiff')?.({
      uri: FILE,
      depotFile: DEPOT,
      haveRev: undefined,
      pending: true,
    })

    expect(client.printRevision).not.toHaveBeenCalled()
    expect(mocks.executeCommand).toHaveBeenCalledWith(
      '_workbench.openDiff',
      expect.objectContaining({ original: '', modified: 'new file content' }),
    )
  })

  it('does nothing for a file outside every client root', async () => {
    const handlers = registeredHandlers()
    createPerforceTimelineCommands(fakeManager(undefined))

    await handlers.get('perforce.timeline.openDiff')?.({
      uri: FILE,
      depotFile: DEPOT,
      rev: '3',
      action: 'edit',
    })

    expect(mocks.executeCommand).not.toHaveBeenCalledWith('_workbench.openDiff', expect.anything())
  })
})

describe('perforce.timeline.copyChangelistNumber', () => {
  it('copies the item id (the changelist number) to the clipboard', async () => {
    const handlers = new Map<string, (arg: unknown) => unknown>()
    mocks.registerCommand.mockImplementation((id: string, handler: (arg: unknown) => unknown) => {
      handlers.set(id, handler)
      return { dispose: () => undefined }
    })
    createPerforceTimelineCommands(fakeManager(fakeClient()))

    await handlers.get('perforce.timeline.copyChangelistNumber')?.({ id: '12345' })

    expect(mocks.executeCommand).toHaveBeenCalledWith('_workbench.writeClipboard', '12345')
  })
})

describe('perforce.timeline.openInGraph', () => {
  it('routes the changelist number through the graph bridge command', async () => {
    const handlers = new Map<string, (arg: unknown) => unknown>()
    mocks.registerCommand.mockImplementation((id: string, handler: (arg: unknown) => unknown) => {
      handlers.set(id, handler)
      return { dispose: () => undefined }
    })
    createPerforceTimelineCommands(fakeManager(fakeClient()))

    await handlers.get('perforce.timeline.openInGraph')?.({ id: '12345' })

    expect(mocks.executeCommand).toHaveBeenCalledWith('_workbench.openPerforceGraph', '12345')

    mocks.executeCommand.mockClear()
    await handlers.get('perforce.timeline.openInGraph')?.({ label: 'no id' })
    expect(mocks.executeCommand).not.toHaveBeenCalled()
  })
})

describe('perforce.timeline.viewCommit', () => {
  function registeredHandlers(): Map<string, (arg: unknown) => unknown> {
    const handlers = new Map<string, (arg: unknown) => unknown>()
    mocks.registerCommand.mockImplementation((id: string, handler: (arg: unknown) => unknown) => {
      handlers.set(id, handler)
      return { dispose: () => undefined }
    })
    return handlers
  }

  it('takes the changelist from the item id and the uri from its command arguments', async () => {
    const client = fakeClient({
      getGraphChangeDetails: vi.fn(async () => ({
        id: '12345',
        author: 'alice',
        client: 'alice-ws',
        date: 1700000000,
        body: 'fix the crash',
        files: [{ depotFile: DEPOT, action: 'edit', rev: '3' }],
        localPaths: new Map([[DEPOT, FILE]]),
      })),
    })
    const handlers = registeredHandlers()
    createPerforceTimelineCommands(fakeManager(client))

    await handlers.get('perforce.timeline.viewCommit')?.({
      id: '12345',
      command: { arguments: [{ uri: FILE }] },
    })

    expect(client.getGraphChangeDetails).toHaveBeenCalledWith('12345')
    expect(mocks.executeCommand).toHaveBeenCalledWith(
      '_workbench.showCommitChanges',
      expect.objectContaining({
        providerId: 'perforce',
        commitRef: '12345',
        openExternalCommand: 'perforce-graph.openFileDiff',
        title: 'Changelist 12345 — fix the crash',
        metadata: { author: 'alice', authorDate: 1700000000, message: 'fix the crash' },
        files: [
          expect.objectContaining({
            path: 'depot/main/src/a.txt',
            status: 'M',
            resourcePath: FILE,
            args: { depotFile: DEPOT, status: 'M', rev: '3', localPath: FILE },
          }),
        ],
      }),
    )
  })

  it('no-ops when the item carries no changelist id', async () => {
    const client = fakeClient({
      getGraphChangeDetails: vi.fn(async () => {
        throw new Error('should not be called')
      }),
    })
    const handlers = registeredHandlers()
    createPerforceTimelineCommands(fakeManager(client))

    await handlers.get('perforce.timeline.viewCommit')?.({ label: 'Pending Changes' })

    expect(mocks.executeCommand).not.toHaveBeenCalled()
  })
})

describe('PerforceTimelineProvider.trackClient', () => {
  it('debounces a client change burst into one reset event', () => {
    vi.useFakeTimers()
    let clientListener: (() => void) | undefined
    const client = fakeClient({
      onDidChange: (l: () => void) => {
        clientListener = l
        return { dispose: () => undefined }
      },
    })
    const provider = new PerforceTimelineProvider(fakeManager(client))
    const events: unknown[] = []
    provider.onDidChange((e) => events.push(e))

    const sub = provider.trackClient(client)
    clientListener!()
    clientListener!()
    clientListener!()
    vi.advanceTimersByTime(250)

    expect(events).toEqual([{ reset: true }])
    sub.dispose()
  })
})

describe('ClientManager.resolveContaining', () => {
  function clientAt(root: string): PerforceClient {
    return { root, dispose: () => undefined } as unknown as PerforceClient
  }

  it('matches the longest containing root and never falls back to active', () => {
    const mgr = new ClientManager()
    const outer = clientAt(ROOT)
    const nested = clientAt(join(ROOT, 'nested'))
    mgr.add(outer)
    mgr.add(nested)

    expect(mgr.resolveContaining(join(ROOT, 'src', 'a.txt'))).toBe(outer)
    expect(mgr.resolveContaining(join(ROOT, 'nested', 'a.txt'))).toBe(nested)
    // Outside every root: undefined even though an active client exists.
    expect(
      mgr.resolveContaining(process.platform === 'win32' ? 'D:\\else\\a.txt' : '/else/a.txt'),
    ).toBeUndefined()
  })
})
