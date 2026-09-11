/*---------------------------------------------------------------------------------------------
 *  Tests for SessionWatchedChangesContribution — the fs-watch fallback that
 *  surfaces agent shell writes in the session diff as inferred entries.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  Emitter,
  URI,
  observableValue,
  type ICommandService,
  type IFileChangeEvent,
  type IFileService,
  type IFileWatcherService,
  type IObservable,
  type IUriIdentityService,
} from '@universe-editor/platform'
import { SessionWatchedChangesContribution } from '../SessionWatchedChangesContribution.js'
import type { IEnvironmentSnapshotService } from '../../../shared/ipc/environmentSnapshotService.js'
import {
  type ISessionChangeTrackerService,
  type SessionFileChange,
} from '../../services/acp/session/sessionChangeTracker.js'
import { type IAcpSessionService } from '../../services/acp/session/acpSessionService.js'
import { type IAcpSession } from '../../services/acp/session/acpSessionModel.js'
import { type IScmService } from '../../services/extensions/ScmService.js'
import { type IP4IgnoreService } from '../../services/scm/P4IgnoreService.js'
import { noteSelfWrite, resetSelfWritesForTests } from '../../services/editor/selfWriteRegistry.js'
import { StubLoggerService } from '../../__tests__/_helpers/stubLoggerService.js'

function makeWatcher(): { watcher: IFileWatcherService; emitter: Emitter<IFileChangeEvent[]> } {
  const emitter = new Emitter<IFileChangeEvent[]>()
  return { watcher: { onDidChangeFiles: emitter.event } as unknown as IFileWatcherService, emitter }
}

function makeSessions(
  status: string,
  idOnAgent: string | undefined = 'agent-1',
): IAcpSessionService {
  const session = {
    status: observableValue('status', status),
    sessionIdOnAgent: observableValue<string | undefined>('sid', idOnAgent),
  } as unknown as IAcpSession
  return {
    sessions: observableValue<readonly IAcpSession[]>('sessions', [session]),
  } as unknown as IAcpSessionService
}

interface TrackerStub extends ISessionChangeTrackerService {
  readonly watched: { sessionId: string; path: string; baseline?: string | null }[]
  /** Seed the "already tracked" branch without recording a change. */
  markTracked(sessionId: string, path: string): void
}

function makeTracker(): TrackerStub {
  const obs: IObservable<readonly SessionFileChange[]> = observableValue('changes', [])
  const watched: TrackerStub['watched'] = []
  const entries = new Set<string>()
  const key = (sessionId: string, path: string): string => `${sessionId}\n${path}`
  return {
    watched,
    markTracked: (sessionId: string, path: string) => void entries.add(key(sessionId, path)),
    changesFor: () => obs,
    hasEntry: (sessionId: string, path: string) => entries.has(key(sessionId, path)),
    recordWatched(sessionId: string, path: string, opts?: { baseline?: string | null }) {
      watched.push({
        sessionId,
        path,
        ...(opts?.baseline !== undefined ? { baseline: opts.baseline } : {}),
      })
      entries.add(key(sessionId, path))
    },
  } as unknown as TrackerStub
}

function makeScm(rootUri: string | null = '/ws'): IScmService {
  return {
    sourceControls: observableValue('sc', rootUri === null ? [] : [{ id: 'git', rootUri }]),
  } as unknown as IScmService
}

function makeCommands(headContent: string | null | undefined): ICommandService {
  return {
    executeCommand: vi
      .fn()
      .mockImplementation((id: string) =>
        Promise.resolve(id.endsWith('.checkIgnore') ? [] : headContent),
      ),
  } as unknown as ICommandService
}

function makeCheckIgnoreCommands(
  checkIgnore: string[] | undefined | Error,
  headContent: string | null = 'head content',
): ICommandService {
  return {
    executeCommand: vi.fn().mockImplementation((id: string) => {
      if (!id.endsWith('.checkIgnore')) return Promise.resolve(headContent)
      if (checkIgnore instanceof Error) return Promise.reject(checkIgnore)
      return Promise.resolve(checkIgnore)
    }),
  } as unknown as ICommandService
}

function makeFiles(
  kind: 'file' | 'directory' | 'missing',
  head: Uint8Array | Error | { readonly binaryPaths: readonly string[] } = new Uint8Array(),
): IFileService {
  const binaryPaths =
    head instanceof Uint8Array || head instanceof Error
      ? undefined
      : new Set(head.binaryPaths.map((p) => URI.file(p).fsPath))
  const uniform = head instanceof Uint8Array ? head : new Uint8Array()
  return {
    stat: vi.fn().mockImplementation(() => {
      if (kind === 'missing') return Promise.reject(new Error('ENOENT'))
      return Promise.resolve({ isFile: kind === 'file', isDirectory: kind === 'directory' })
    }),
    readFileHead: vi.fn().mockImplementation((resource: URI) => {
      if (head instanceof Error) return Promise.reject(head)
      if (binaryPaths) {
        return Promise.resolve(binaryPaths.has(resource.fsPath) ? BINARY_HEAD : new Uint8Array())
      }
      return Promise.resolve(uniform)
    }),
  } as unknown as IFileService
}

/** A head sample holding a NUL byte, i.e. what a compiled artifact looks like. */
const BINARY_HEAD = new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 0x00])

const uriIdentity = {
  getComparisonKey: (uri: URI) => uri.toString().toLowerCase(),
  isEqualOrParent(resource: URI | undefined, parent: URI | undefined): boolean {
    if (!resource || !parent) return false
    const rKey = resource.toString().toLowerCase()
    const pKey = parent.toString().toLowerCase()
    if (rKey === pKey) return true
    return rKey.startsWith(pKey.endsWith('/') ? pKey : pKey + '/')
  },
} as unknown as IUriIdentityService

const APP_RESOURCES = 'C:/Users/xxx/AppData/Local/Programs/Universe Editor/resources'
const USER_DATA = '/userdata'

function makeEnvSnapshot(): IEnvironmentSnapshotService {
  return {
    getSnapshot: () =>
      Promise.resolve({
        userHome: '/home/u',
        cwd: '/',
        execPath: '/app/editor.exe',
        userDataDir: USER_DATA,
        appResourcesPath: APP_RESOURCES,
        env: {},
      }),
  } as IEnvironmentSnapshotService
}

async function make(opts: {
  sessions?: IAcpSessionService
  tracker?: TrackerStub
  scm?: IScmService
  commands?: ICommandService
  files?: IFileService
  envSnapshot?: IEnvironmentSnapshotService
  p4Ignore?: IP4IgnoreService
}): Promise<{
  contrib: SessionWatchedChangesContribution
  emitter: Emitter<IFileChangeEvent[]>
  tracker: TrackerStub
  commands: ICommandService
}> {
  const { watcher, emitter } = makeWatcher()
  const tracker = opts.tracker ?? makeTracker()
  const commands = opts.commands ?? makeCommands('head content')
  const contrib = new SessionWatchedChangesContribution(
    watcher,
    opts.sessions ?? makeSessions('running'),
    tracker,
    opts.scm ?? makeScm(),
    commands,
    opts.files ?? makeFiles('file'),
    uriIdentity,
    new StubLoggerService(),
    opts.envSnapshot ?? makeEnvSnapshot(),
    opts.p4Ignore ?? makeP4Ignore(),
  )
  // Let the constructor's getSnapshot().then(...) land before events are fired.
  await Promise.resolve()
  contrib.flushDelayMs = 0
  return { contrib, emitter, tracker, commands }
}

/** Default stand-in: the built-in layer ignores nothing unless a test says so. */
function makeP4Ignore(
  resolve: (paths: readonly string[]) => Promise<ReadonlySet<string>> = () =>
    Promise.resolve(new Set()),
): IP4IgnoreService {
  return { resolveIgnored: vi.fn().mockImplementation(resolve) } as unknown as IP4IgnoreService
}

async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 10))
}

const FOO = URI.file('/ws/foo.ts')
const BUNDLED_THEME = URI.file(`${APP_RESOURCES}/extensions/theme-defaults/themes/dark_plus.json`)
const APP_LOG = URI.file(`${USER_DATA}/logs/window-1/console.log`)
const OUTSIDE_WS_PLAN = URI.file('C:/Users/xxx/.claude/plans/plan.md')

describe('SessionWatchedChangesContribution', () => {
  afterEach(() => resetSelfWritesForTests())

  it('drops changes under the packaged resources dir (bundled themes) even while a session is running', async () => {
    const { contrib, emitter, tracker } = await make({})
    emitter.fire([{ type: 'modified', resource: BUNDLED_THEME }])
    await flush()
    expect(tracker.watched).toEqual([])
    contrib.dispose()
  })

  it('drops changes under the userData dir (app state / logs)', async () => {
    const { contrib, emitter, tracker } = await make({})
    emitter.fire([{ type: 'modified', resource: APP_LOG }])
    await flush()
    expect(tracker.watched).toEqual([])
    contrib.dispose()
  })

  it('records changes outside the workspace that are not app-owned', async () => {
    const { contrib, emitter, tracker } = await make({})
    emitter.fire([{ type: 'modified', resource: OUTSIDE_WS_PLAN }])
    await flush()
    expect(tracker.watched).toEqual([{ sessionId: 'agent-1', path: OUTSIDE_WS_PLAN.fsPath }])
    contrib.dispose()
  })

  it('records an unreported change with a git baseline for the running session', async () => {
    const { contrib, emitter, tracker, commands } = await make({})
    emitter.fire([{ type: 'modified', resource: FOO }])
    await flush()
    expect(tracker.watched).toEqual([
      { sessionId: 'agent-1', path: FOO.fsPath, baseline: 'head content' },
    ])
    expect(commands.executeCommand).toHaveBeenCalledWith('git.getHeadContent', FOO.fsPath)
    contrib.dispose()
  })

  it('ignores changes while no session turn is running', async () => {
    const { contrib, emitter, tracker } = await make({ sessions: makeSessions('idle') })
    emitter.fire([{ type: 'modified', resource: FOO }])
    await flush()
    expect(tracker.watched).toEqual([])
    contrib.dispose()
  })

  it('still records when the turn ends before the flush fires', async () => {
    const sessions = makeSessions('running')
    const { contrib, emitter, tracker } = await make({ sessions })
    contrib.flushDelayMs = 5
    emitter.fire([{ type: 'modified', resource: FOO }])
    const session = sessions.sessions.get()[0]!
    ;(session.status as unknown as { set(v: string, tx: undefined): void }).set('idle', undefined)
    await flush()
    expect(tracker.watched).toHaveLength(1)
    contrib.dispose()
  })

  it('excludes paths the editor itself just saved', async () => {
    const { contrib, emitter, tracker } = await make({})
    noteSelfWrite(FOO)
    emitter.fire([{ type: 'modified', resource: FOO }])
    await flush()
    expect(tracker.watched).toEqual([])
    contrib.dispose()
  })

  it('only refreshes an already-tracked path (no git lookup, no new entry data)', async () => {
    const tracker = makeTracker()
    tracker.markTracked('agent-1', FOO.fsPath)
    const { contrib, emitter, commands } = await make({ tracker })
    emitter.fire([{ type: 'modified', resource: FOO }])
    await flush()
    expect(tracker.watched).toEqual([{ sessionId: 'agent-1', path: FOO.fsPath }])
    expect(commands.executeCommand).not.toHaveBeenCalledWith('git.getHeadContent', FOO.fsPath)
    contrib.dispose()
  })

  it('does not re-fetch a baseline for a record that renders no row', async () => {
    // Dismissed, self-healed, degraded-to-nothing: the record exists without a
    // row, so the row scan used to send us back for a full git HEAD read on
    // every single pass.
    const tracker = makeTracker()
    tracker.markTracked('agent-1', FOO.fsPath)
    const { contrib, emitter, commands } = await make({ tracker })
    emitter.fire([{ type: 'modified', resource: FOO }])
    await flush()
    emitter.fire([{ type: 'modified', resource: FOO }])
    await flush()
    expect(commands.executeCommand).not.toHaveBeenCalledWith('git.getHeadContent', FOO.fsPath)
    contrib.dispose()
  })

  it('maps a missing HEAD revision to a created (null) baseline', async () => {
    const { contrib, emitter, tracker } = await make({ commands: makeCommands(null) })
    emitter.fire([{ type: 'added', resource: FOO }])
    await flush()
    expect(tracker.watched).toEqual([{ sessionId: 'agent-1', path: FOO.fsPath, baseline: null }])
    contrib.dispose()
  })

  it('records without a baseline when no SCM provider owns the path', async () => {
    const { contrib, emitter, tracker, commands } = await make({ scm: makeScm(null) })
    emitter.fire([{ type: 'modified', resource: FOO }])
    await flush()
    expect(tracker.watched).toEqual([{ sessionId: 'agent-1', path: FOO.fsPath }])
    expect(commands.executeCommand).not.toHaveBeenCalled()
    contrib.dispose()
  })

  it('records without a baseline when getHeadContent is not registered yet', async () => {
    const { contrib, emitter, tracker } = await make({ commands: makeCommands(undefined) })
    emitter.fire([{ type: 'modified', resource: FOO }])
    await flush()
    expect(tracker.watched).toEqual([{ sessionId: 'agent-1', path: FOO.fsPath }])
    contrib.dispose()
  })

  it('skips directory events', async () => {
    const { contrib, emitter, tracker } = await make({ files: makeFiles('directory') })
    emitter.fire([{ type: 'added', resource: URI.file('/ws/newdir') }])
    await flush()
    expect(tracker.watched).toEqual([])
    contrib.dispose()
  })

  it('records a confirmed deletion with its git baseline', async () => {
    const { contrib, emitter, tracker } = await make({ files: makeFiles('missing') })
    emitter.fire([{ type: 'deleted', resource: FOO }])
    await flush()
    expect(tracker.watched).toEqual([
      { sessionId: 'agent-1', path: FOO.fsPath, baseline: 'head content' },
    ])
    contrib.dispose()
  })

  it('coalesces repeated events for the same path into one record', async () => {
    const { contrib, emitter, tracker } = await make({})
    contrib.flushDelayMs = 5
    emitter.fire([{ type: 'modified', resource: FOO }])
    emitter.fire([{ type: 'modified', resource: FOO }])
    await flush()
    expect(tracker.watched).toHaveLength(1)
    contrib.dispose()
  })

  it('drops gitignored paths without recording them', async () => {
    const commands = makeCheckIgnoreCommands([FOO.fsPath])
    const { contrib, emitter, tracker } = await make({ commands })
    emitter.fire([{ type: 'modified', resource: FOO }])
    await flush()
    expect(tracker.watched).toEqual([])
    expect(commands.executeCommand).toHaveBeenCalledWith('git.checkIgnore', [FOO.fsPath])
    expect(commands.executeCommand).not.toHaveBeenCalledWith('git.getHeadContent', FOO.fsPath)
    contrib.dispose()
  })

  it('records unfiltered when checkIgnore is not registered yet', async () => {
    const { contrib, emitter, tracker } = await make({
      commands: makeCheckIgnoreCommands(undefined),
    })
    emitter.fire([{ type: 'modified', resource: FOO }])
    await flush()
    expect(tracker.watched).toEqual([
      { sessionId: 'agent-1', path: FOO.fsPath, baseline: 'head content' },
    ])
    contrib.dispose()
  })

  it('still records when the checkIgnore call fails (degrades to unfiltered)', async () => {
    const { contrib, emitter, tracker } = await make({
      commands: makeCheckIgnoreCommands(new Error('git blew up')),
    })
    emitter.fire([{ type: 'modified', resource: FOO }])
    await flush()
    expect(tracker.watched).toEqual([
      { sessionId: 'agent-1', path: FOO.fsPath, baseline: 'head content' },
    ])
    contrib.dispose()
  })

  it('drops a binary artifact without recording it or fetching a baseline', async () => {
    const { contrib, emitter, tracker, commands } = await make({
      files: makeFiles('file', BINARY_HEAD),
    })
    emitter.fire([{ type: 'modified', resource: URI.file('/ws/build/out.obj') }])
    await flush()
    expect(tracker.watched).toEqual([])
    // The whole point of the gate: no full-text round trip — neither the
    // per-path HEAD read (whole file) nor a recorded entry the tracker would
    // then read whole. The batch check-ignore is one metadata command for the
    // whole flush and is expected to still cover the path.
    expect(commands.executeCommand).not.toHaveBeenCalledWith(
      'git.getHeadContent',
      URI.file('/ws/build/out.obj').fsPath,
    )
    contrib.dispose()
  })

  it('keeps a text file whose head read fails', async () => {
    const { contrib, emitter, tracker } = await make({
      files: makeFiles('file', new Error('EACCES')),
    })
    emitter.fire([{ type: 'modified', resource: FOO }])
    await flush()
    expect(tracker.watched).toEqual([
      { sessionId: 'agent-1', path: FOO.fsPath, baseline: 'head content' },
    ])
    contrib.dispose()
  })

  it('refreshes a binary path that is already tracked, so the row can be cleared', async () => {
    const tracker = makeTracker()
    tracker.markTracked('agent-1', FOO.fsPath)
    const { contrib, emitter } = await make({ tracker, files: makeFiles('file', BINARY_HEAD) })
    emitter.fire([{ type: 'modified', resource: FOO }])
    await flush()
    expect(tracker.watched).toEqual([{ sessionId: 'agent-1', path: FOO.fsPath }])
    contrib.dispose()
  })

  it('keeps a text sibling of a dropped binary', async () => {
    const { contrib, emitter, tracker } = await make({
      files: makeFiles('file', { binaryPaths: ['/ws/build/out.obj'] }),
    })
    emitter.fire([
      { type: 'modified', resource: URI.file('/ws/src/a.ts') },
      { type: 'modified', resource: URI.file('/ws/build/out.obj') },
    ])
    await flush()
    expect(tracker.watched).toEqual([
      { sessionId: 'agent-1', path: URI.file('/ws/src/a.ts').fsPath, baseline: 'head content' },
    ])
    contrib.dispose()
  })

  it('drops a path the built-in rules ignore even with no SCM provider registered', async () => {
    // The incident this layer exists for: sourceControls is empty, so the
    // delegated check-ignore answers nothing at all.
    const { contrib, emitter, tracker, commands } = await make({
      scm: makeScm(null),
      p4Ignore: makeP4Ignore((paths) => Promise.resolve(new Set(paths))),
    })
    emitter.fire([{ type: 'modified', resource: URI.file('/ws/build/out.obj') }])
    await flush()
    expect(tracker.watched).toEqual([])
    expect(commands.executeCommand).not.toHaveBeenCalled()
    contrib.dispose()
  })

  it('records a path neither source ignores', async () => {
    const { contrib, emitter, tracker } = await make({
      p4Ignore: makeP4Ignore((paths) =>
        Promise.resolve(new Set(paths.filter((p) => p.endsWith('.obj')))),
      ),
    })
    emitter.fire([{ type: 'modified', resource: URI.file('/ws/build/out.obj') }])
    emitter.fire([{ type: 'modified', resource: URI.file('/ws/src/a.ts') }])
    await flush()
    expect(tracker.watched).toEqual([
      { sessionId: 'agent-1', path: URI.file('/ws/src/a.ts').fsPath, baseline: 'head content' },
    ])
    contrib.dispose()
  })

  it('unions the two sources rather than letting the provider win', async () => {
    // git owns the path and says "not ignored" (it has no .p4ignore knowledge);
    // the built-in layer says ignored. Either source dropping it is enough.
    const commands = makeCheckIgnoreCommands([])
    const { contrib, emitter, tracker } = await make({
      commands,
      p4Ignore: makeP4Ignore((paths) => Promise.resolve(new Set(paths))),
    })
    emitter.fire([{ type: 'modified', resource: FOO }])
    await flush()
    expect(commands.executeCommand).toHaveBeenCalledWith('git.checkIgnore', [FOO.fsPath])
    expect(tracker.watched).toEqual([])
    contrib.dispose()
  })

  it('keeps the batch unfiltered when the built-in rules throw', async () => {
    const { contrib, emitter, tracker } = await make({
      p4Ignore: makeP4Ignore(() => Promise.reject(new Error('rule parse blew up'))),
    })
    emitter.fire([{ type: 'modified', resource: FOO }])
    await flush()
    expect(tracker.watched).toEqual([
      { sessionId: 'agent-1', path: FOO.fsPath, baseline: 'head content' },
    ])
    contrib.dispose()
  })
})
