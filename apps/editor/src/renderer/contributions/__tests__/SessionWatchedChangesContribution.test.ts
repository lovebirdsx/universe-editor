/*---------------------------------------------------------------------------------------------
 *  Tests for SessionWatchedChangesContribution — the fs-watch fallback that
 *  surfaces agent shell writes in the session diff as inferred entries.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  Emitter,
  LogLevel,
  NullLogger,
  URI,
  observableValue,
  type ICommandService,
  type IFileChangeEvent,
  type IFileService,
  type IFileWatcherService,
  type ILogger,
  type ILoggerService,
  type IObservable,
  type IUriIdentityService,
} from '@universe-editor/platform'
import { SessionWatchedChangesContribution } from '../SessionWatchedChangesContribution.js'
import {
  type ISessionChangeTrackerService,
  type SessionFileChange,
} from '../../services/acp/session/sessionChangeTracker.js'
import { type IAcpSessionService } from '../../services/acp/session/acpSessionService.js'
import { type IAcpSession } from '../../services/acp/session/acpSessionModel.js'
import { type IScmService } from '../../services/extensions/ScmService.js'
import { noteSelfWrite, resetSelfWritesForTests } from '../../services/editor/selfWriteRegistry.js'

class StubLoggerService implements ILoggerService {
  declare readonly _serviceBrand: undefined
  createLogger(): ILogger {
    return new NullLogger()
  }
  setLevel(): void {}
  getLevel(): LogLevel {
    return LogLevel.Info
  }
}

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
}

function makeTracker(changes: readonly SessionFileChange[] = []): TrackerStub {
  const obs: IObservable<readonly SessionFileChange[]> = observableValue('changes', changes)
  const watched: TrackerStub['watched'] = []
  return {
    watched,
    changesFor: () => obs,
    recordWatched(sessionId: string, path: string, opts?: { baseline?: string | null }) {
      watched.push({
        sessionId,
        path,
        ...(opts?.baseline !== undefined ? { baseline: opts.baseline } : {}),
      })
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
    executeCommand: vi.fn().mockResolvedValue(headContent),
  } as unknown as ICommandService
}

function makeFiles(kind: 'file' | 'directory' | 'missing'): IFileService {
  return {
    stat: vi.fn().mockImplementation(() => {
      if (kind === 'missing') return Promise.reject(new Error('ENOENT'))
      return Promise.resolve({ isFile: kind === 'file', isDirectory: kind === 'directory' })
    }),
  } as unknown as IFileService
}

const uriIdentity = {
  getComparisonKey: (uri: URI) => uri.toString().toLowerCase(),
} as unknown as IUriIdentityService

function make(opts: {
  sessions?: IAcpSessionService
  tracker?: TrackerStub
  scm?: IScmService
  commands?: ICommandService
  files?: IFileService
}): {
  contrib: SessionWatchedChangesContribution
  emitter: Emitter<IFileChangeEvent[]>
  tracker: TrackerStub
  commands: ICommandService
} {
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
  )
  contrib.flushDelayMs = 0
  return { contrib, emitter, tracker, commands }
}

async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 10))
}

const FOO = URI.file('/ws/foo.ts')

describe('SessionWatchedChangesContribution', () => {
  afterEach(() => resetSelfWritesForTests())

  it('records an unreported change with a git baseline for the running session', async () => {
    const { contrib, emitter, tracker, commands } = make({})
    emitter.fire([{ type: 'modified', resource: FOO }])
    await flush()
    expect(tracker.watched).toEqual([
      { sessionId: 'agent-1', path: FOO.fsPath, baseline: 'head content' },
    ])
    expect(commands.executeCommand).toHaveBeenCalledWith('git.getHeadContent', FOO.fsPath)
    contrib.dispose()
  })

  it('ignores changes while no session turn is running', async () => {
    const { contrib, emitter, tracker } = make({ sessions: makeSessions('idle') })
    emitter.fire([{ type: 'modified', resource: FOO }])
    await flush()
    expect(tracker.watched).toEqual([])
    contrib.dispose()
  })

  it('still records when the turn ends before the flush fires', async () => {
    const sessions = makeSessions('running')
    const { contrib, emitter, tracker } = make({ sessions })
    contrib.flushDelayMs = 5
    emitter.fire([{ type: 'modified', resource: FOO }])
    const session = sessions.sessions.get()[0]!
    ;(session.status as unknown as { set(v: string, tx: undefined): void }).set('idle', undefined)
    await flush()
    expect(tracker.watched).toHaveLength(1)
    contrib.dispose()
  })

  it('excludes paths the editor itself just saved', async () => {
    const { contrib, emitter, tracker } = make({})
    noteSelfWrite(FOO)
    emitter.fire([{ type: 'modified', resource: FOO }])
    await flush()
    expect(tracker.watched).toEqual([])
    contrib.dispose()
  })

  it('only refreshes an already-tracked path (no git lookup, no new entry data)', async () => {
    const tracked: SessionFileChange = {
      uri: FOO,
      path: FOO.fsPath,
      baseline: 'a',
      current: 'b',
      status: 'modified',
      origin: 'agent',
      baselineSource: 'reported',
      batchCount: 1,
    }
    const { contrib, emitter, tracker, commands } = make({ tracker: makeTracker([tracked]) })
    emitter.fire([{ type: 'modified', resource: FOO }])
    await flush()
    expect(tracker.watched).toEqual([{ sessionId: 'agent-1', path: FOO.fsPath }])
    expect(commands.executeCommand).not.toHaveBeenCalled()
    contrib.dispose()
  })

  it('maps a missing HEAD revision to a created (null) baseline', async () => {
    const { contrib, emitter, tracker } = make({ commands: makeCommands(null) })
    emitter.fire([{ type: 'added', resource: FOO }])
    await flush()
    expect(tracker.watched).toEqual([{ sessionId: 'agent-1', path: FOO.fsPath, baseline: null }])
    contrib.dispose()
  })

  it('records without a baseline when no SCM provider owns the path', async () => {
    const { contrib, emitter, tracker, commands } = make({ scm: makeScm(null) })
    emitter.fire([{ type: 'modified', resource: FOO }])
    await flush()
    expect(tracker.watched).toEqual([{ sessionId: 'agent-1', path: FOO.fsPath }])
    expect(commands.executeCommand).not.toHaveBeenCalled()
    contrib.dispose()
  })

  it('records without a baseline when getHeadContent is not registered yet', async () => {
    const { contrib, emitter, tracker } = make({ commands: makeCommands(undefined) })
    emitter.fire([{ type: 'modified', resource: FOO }])
    await flush()
    expect(tracker.watched).toEqual([{ sessionId: 'agent-1', path: FOO.fsPath }])
    contrib.dispose()
  })

  it('skips directory events', async () => {
    const { contrib, emitter, tracker } = make({ files: makeFiles('directory') })
    emitter.fire([{ type: 'added', resource: URI.file('/ws/newdir') }])
    await flush()
    expect(tracker.watched).toEqual([])
    contrib.dispose()
  })

  it('records a confirmed deletion with its git baseline', async () => {
    const { contrib, emitter, tracker } = make({ files: makeFiles('missing') })
    emitter.fire([{ type: 'deleted', resource: FOO }])
    await flush()
    expect(tracker.watched).toEqual([
      { sessionId: 'agent-1', path: FOO.fsPath, baseline: 'head content' },
    ])
    contrib.dispose()
  })

  it('coalesces repeated events for the same path into one record', async () => {
    const { contrib, emitter, tracker } = make({})
    contrib.flushDelayMs = 5
    emitter.fire([{ type: 'modified', resource: FOO }])
    emitter.fire([{ type: 'modified', resource: FOO }])
    await flush()
    expect(tracker.watched).toHaveLength(1)
    contrib.dispose()
  })
})
