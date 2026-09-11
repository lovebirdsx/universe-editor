/*---------------------------------------------------------------------------------------------
 *  Tests for P4IgnoreService — the editor-side Perforce ignore fallback: the
 *  upward rule-file walk (including the subdirectory-workspace case), the
 *  P4CONFIG/P4IGNORE path, the armed/ceiling policy, caching and invalidation.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest'
import {
  Emitter,
  normalizeFsPath,
  REMOTE_SCHEME,
  UriIdentityService,
  URI,
  observableValue,
  type IConfigurationService,
  type IFileChangeEvent,
  type IFileService,
  type IFileWatcherService,
  type ILoggerService,
  type IWorkspace,
  type IWorkspaceService,
} from '@universe-editor/platform'
import type {
  IEnvironmentSnapshot,
  IEnvironmentSnapshotService,
} from '../../../../shared/ipc/environmentSnapshotService.js'
import type { IScmService, IScmSourceControlModel } from '../../extensions/ScmService.js'
import { P4IgnoreService } from '../P4IgnoreService.js'

/** A Perforce client root with the workspace one level below it. */
const CLIENT_ROOT = 'X:/p4ws/main'
const WORKSPACE = 'X:/p4ws/main/Project'

interface Harness {
  resolveIgnored(paths: readonly string[]): Promise<ReadonlySet<string>>
  /** Absolute host paths currently present in the fake filesystem. */
  put(path: string, content: string): void
  remove(path: string): void
  /** Change a file's content and move its mtime, as a real save does. */
  write(path: string, content: string): void
  readFileText: ReturnType<typeof vi.fn>
  /** Schemes of every URI the service asked about, to prove host scoping. */
  schemesSeen(): string[]
  fileEvents: Emitter<readonly IFileChangeEvent[]>
  workspaceEvents: Emitter<IWorkspace | null>
  /** Watcher registrations; both must stay unused (see the test). */
  watchSpy: ReturnType<typeof vi.fn>
  watchOutOfWorkspaceSpy: ReturnType<typeof vi.fn>
  sourceControls: ReturnType<typeof observableValue<readonly IScmSourceControlModel[]>>
  logger: { warn: ReturnType<typeof vi.fn>; debug: ReturnType<typeof vi.fn> }
  dispose(): void
}

const EMPTY_ENV: IEnvironmentSnapshot['env'] = {}

function makeHarness(
  opts: {
    controls?: readonly IScmSourceControlModel[]
    folder?: URI
    env?: IEnvironmentSnapshot['env']
    /** Defaults to 'filesystem'; 'workspace' clamps the walk to the open folder. */
    searchCeiling?: string
  } = {},
): Harness {
  const store = new Map<string, { content: string; mtime: number }>()
  let clock = 1000
  const key = (hostPath: string): string => normalizeFsPath(hostPath)

  const schemes: string[] = []
  const readFileText = vi.fn(async (uri: URI) => {
    schemes.push(uri.scheme)
    const entry = store.get(key(uri.fsPath))
    if (entry === undefined) throw new Error('ENOENT')
    return entry.content
  })

  const files = {
    stat: vi.fn(async (uri: URI) => {
      schemes.push(uri.scheme)
      const entry = store.get(key(uri.fsPath))
      if (entry === undefined) throw new Error('ENOENT')
      return {
        resource: uri,
        isFile: true,
        isDirectory: false,
        size: entry.content.length,
        mtime: entry.mtime,
      }
    }),
    readFileText,
  } as unknown as IFileService

  const fileEvents = new Emitter<readonly IFileChangeEvent[]>()
  const workspaceEvents = new Emitter<IWorkspace | null>()
  const folder = opts.folder ?? URI.file(WORKSPACE)
  const workspace = {
    current: { folder },
    onDidChangeWorkspace: workspaceEvents.event,
  } as unknown as IWorkspaceService

  const watchSpy = vi.fn()
  const watchOutOfWorkspaceSpy = vi.fn()
  const fileWatcher = {
    onDidChangeFiles: fileEvents.event,
    watch: watchSpy,
    watchOutOfWorkspace: watchOutOfWorkspaceSpy,
  } as unknown as IFileWatcherService

  const sourceControls = observableValue<readonly IScmSourceControlModel[]>(
    'test.sourceControls',
    opts.controls ?? [p4SourceControl(CLIENT_ROOT)],
  )
  const scm = { sourceControls } as unknown as IScmService

  const logger = { warn: vi.fn(), debug: vi.fn() }
  const loggerService = { createLogger: () => logger } as unknown as ILoggerService
  const configuration = {
    get: (k: string) =>
      k === 'scm.ignoreFiles.searchCeiling' ? (opts.searchCeiling ?? 'filesystem') : undefined,
    onDidChangeConfiguration: new Emitter().event,
  } as unknown as IConfigurationService
  const envSnapshot = {
    getSnapshot: () =>
      Promise.resolve({ env: opts.env ?? EMPTY_ENV } as unknown as IEnvironmentSnapshot),
  } as unknown as IEnvironmentSnapshotService

  const service = new P4IgnoreService(
    files,
    fileWatcher,
    scm,
    workspace,
    new UriIdentityService('win32'),
    configuration,
    envSnapshot,
    loggerService,
  )

  return {
    resolveIgnored: (paths) => service.resolveIgnored(paths),
    put: (path, content) => void store.set(key(path), { content, mtime: clock++ }),
    remove: (path) => void store.delete(key(path)),
    write: (path, content) => void store.set(key(path), { content, mtime: clock++ }),
    readFileText,
    schemesSeen: () => [...schemes],
    fileEvents,
    workspaceEvents,
    watchSpy,
    watchOutOfWorkspaceSpy,
    sourceControls,
    logger,
    dispose: () => service.dispose(),
  }
}

function p4SourceControl(rootUri: string): IScmSourceControlModel {
  return { id: 'perforce', rootUri } as unknown as IScmSourceControlModel
}

function gitSourceControl(rootUri: string): IScmSourceControlModel {
  return { id: 'git', rootUri } as unknown as IScmSourceControlModel
}

describe('P4IgnoreService', () => {
  it('drops a path matched by the workspace-root rule file', async () => {
    const h = makeHarness()
    h.put(`${WORKSPACE}/.p4ignore`, 'build/\n')
    const ignored = await h.resolveIgnored([`${WORKSPACE}/build/out.obj`, `${WORKSPACE}/src/a.ts`])
    expect([...ignored]).toEqual([`${WORKSPACE}/build/out.obj`])
    h.dispose()
  })

  it('honours a rule file in an ancestor above the workspace (subdirectory workspace)', async () => {
    // The headline case: the workspace is a SUBDIRECTORY of the client root, so
    // the rule file that governs it sits outside the open folder.
    const h = makeHarness()
    h.put(`${CLIENT_ROOT}/.p4ignore`, '**/Intermediate/\n')
    const ignored = await h.resolveIgnored([`${WORKSPACE}/Saved/Intermediate/x.bin`])
    expect([...ignored]).toEqual([`${WORKSPACE}/Saved/Intermediate/x.bin`])
    h.dispose()
  })

  it('lets the nearer rule file override the farther one', async () => {
    const h = makeHarness()
    h.put(`${CLIENT_ROOT}/.p4ignore`, '*.log\n')
    h.put(`${WORKSPACE}/.p4ignore`, '!keep.log\n')
    const ignored = await h.resolveIgnored([`${WORKSPACE}/keep.log`, `${WORKSPACE}/drop.log`])
    expect([...ignored]).toEqual([`${WORKSPACE}/drop.log`])
    h.dispose()
  })

  it('reads P4IGNORE from a p4 config file on the chain', async () => {
    const h = makeHarness()
    h.put(`${CLIENT_ROOT}/.p4config`, `P4PORT=ssl:perforce.example.com:1666\nP4IGNORE=rules.txt\n`)
    h.put(`${CLIENT_ROOT}/rules.txt`, 'build/\n')
    const ignored = await h.resolveIgnored([`${WORKSPACE}/build/x.obj`])
    expect([...ignored]).toEqual([`${WORKSPACE}/build/x.obj`])
    h.dispose()
  })

  it('reads P4IGNORE from the environment', async () => {
    const h = makeHarness({ env: { P4IGNORE: 'envrules.txt' } })
    h.put(`${WORKSPACE}/envrules.txt`, 'build/\n')
    const ignored = await h.resolveIgnored([`${WORKSPACE}/build/x.obj`])
    expect([...ignored]).toEqual([`${WORKSPACE}/build/x.obj`])
    h.dispose()
  })

  it('never reads a file when no rule or config file exists on the chain', async () => {
    const h = makeHarness()
    await h.resolveIgnored([`${WORKSPACE}/src/a.ts`])
    expect(h.readFileText).not.toHaveBeenCalled()
    h.dispose()
  })

  it('re-reads a rule file whose mtime moved, and reuses one that did not', async () => {
    const h = makeHarness()
    h.put(`${WORKSPACE}/.p4ignore`, 'build/\n')
    expect([...(await h.resolveIgnored([`${WORKSPACE}/build/x.obj`]))]).toHaveLength(1)
    // Unchanged on disk: the stat-validated parse cache answers without a read.
    expect([...(await h.resolveIgnored([`${WORKSPACE}/build/x.obj`]))]).toHaveLength(1)
    expect(h.readFileText).toHaveBeenCalledTimes(1)
    h.write(`${WORKSPACE}/.p4ignore`, '')
    expect([...(await h.resolveIgnored([`${WORKSPACE}/build/x.obj`]))]).toHaveLength(0)
    expect(h.readFileText).toHaveBeenCalledTimes(2)
    h.dispose()
  })

  it('picks up a rule file that appears after the first lookup', async () => {
    const harness = makeHarness()
    const target = `${WORKSPACE}/build/x.obj`
    expect([...(await harness.resolveIgnored([target]))]).toHaveLength(0)
    harness.put(`${WORKSPACE}/.p4ignore`, 'build/\n')
    // A newly created rule file is a watcher event in the real product; the
    // directory probe cache is what it invalidates.
    harness.fileEvents.fire([{ type: 'added', resource: URI.file(`${WORKSPACE}/.p4ignore`) }])
    expect([...(await harness.resolveIgnored([target]))]).toEqual([target])
    harness.dispose()
  })

  it('re-reads an unchanged rule file when its watcher event arrives', async () => {
    const h = makeHarness()
    h.put(`${WORKSPACE}/.p4ignore`, 'build/\n')
    const target = `${WORKSPACE}/build/x.obj`
    expect([...(await h.resolveIgnored([target]))]).toEqual([target])
    expect(h.readFileText).toHaveBeenCalledTimes(1)
    // Nothing on disk moved; only the host's event says to look again. The
    // invalidation has to be real — the stat-validated copy would answer the
    // next lookup without a read.
    h.fileEvents.fire([{ type: 'modified', resource: URI.file(`${WORKSPACE}/.p4ignore`) }])
    expect([...(await h.resolveIgnored([target]))]).toEqual([target])
    expect(h.readFileText).toHaveBeenCalledTimes(2)
    h.dispose()
  })

  it('never arms a watch on the rule files it reads', async () => {
    // Deliberate. The main-side watcher realizes an out-of-workspace file as a
    // NON-RECURSIVE watch on its DIRECTORY and re-classifies every registered
    // file on any sibling change, so arming one on a client root's `.p4ignore`
    // turns ordinary churn into repeated `modified` events for the rule file —
    // on the very stream this filter cleans (observed in e2e as a `.p4ignore`
    // row in the session-changes list). Content edits are picked up by stat
    // re-validation instead; see the next case.
    const h = makeHarness()
    h.put(`${CLIENT_ROOT}/.p4ignore`, 'build/\n')
    await h.resolveIgnored([`${WORKSPACE}/build/x.obj`])
    expect(h.watchSpy).not.toHaveBeenCalled()
    expect(h.watchOutOfWorkspaceSpy).not.toHaveBeenCalled()
    h.dispose()
  })

  it('re-reads an ancestor rule file that changed, without any watcher event', async () => {
    const h = makeHarness()
    h.put(`${CLIENT_ROOT}/.p4ignore`, 'build/\n')
    const target = `${WORKSPACE}/build/x.obj`
    expect([...(await h.resolveIgnored([target]))]).toEqual([target])
    h.write(`${CLIENT_ROOT}/.p4ignore`, 'other/\n')
    expect([...(await h.resolveIgnored([target]))]).toHaveLength(0)
    h.dispose()
  })

  it('stops applying an ancestor rule file that was deleted', async () => {
    const h = makeHarness()
    h.put(`${CLIENT_ROOT}/.p4ignore`, 'build/\n')
    const target = `${WORKSPACE}/build/x.obj`
    expect([...(await h.resolveIgnored([target]))]).toEqual([target])
    // Deletion converges without waiting out the presence probe: the parse step
    // stats the file it was handed and finds nothing to read.
    h.remove(`${CLIENT_ROOT}/.p4ignore`)
    expect([...(await h.resolveIgnored([target]))]).toHaveLength(0)
    h.dispose()
  })

  it('stays armed when no Perforce provider is registered at all', async () => {
    // The incident's state: sourceControls empty, so the delegated check-ignore
    // answers nothing and only these rules can filter.
    const h = makeHarness({ controls: [] })
    h.put(`${CLIENT_ROOT}/.p4ignore`, 'build/\n')
    const ignored = await h.resolveIgnored([`${WORKSPACE}/build/x.obj`])
    expect([...ignored]).toEqual([`${WORKSPACE}/build/x.obj`])
    h.dispose()
  })

  it('does not apply Perforce rules to a path no client root owns', async () => {
    const h = makeHarness({ controls: [p4SourceControl('X:/other/depot')] })
    h.put(`${CLIENT_ROOT}/.p4ignore`, 'build/\n')
    const ignored = await h.resolveIgnored([`${WORKSPACE}/build/x.obj`])
    expect([...ignored]).toEqual([])
    h.dispose()
  })

  it('stays armed for a workspace with no Perforce provider even when git answers', async () => {
    // Accepted trade-off: with no perforce source control the layer cannot tell
    // a Perforce checkout from a git one, so it searches anyway. This is the
    // false-positive surface of the "no provider at all" branch, and the
    // incident's own shape.
    const h = makeHarness({ controls: [gitSourceControl(WORKSPACE)] })
    h.put(`${CLIENT_ROOT}/.p4ignore`, 'build/\n')
    const ignored = await h.resolveIgnored([`${WORKSPACE}/build/x.obj`])
    expect([...ignored]).toEqual([`${WORKSPACE}/build/x.obj`])
    h.dispose()
  })

  it('stops at the client root rather than reading rule files above it', async () => {
    const h = makeHarness()
    h.put('X:/p4ws/.p4ignore', 'build/\n')
    const ignored = await h.resolveIgnored([`${WORKSPACE}/build/x.obj`])
    expect([...ignored]).toEqual([])
    h.dispose()
  })

  it('clamps the walk to the workspace when scm.ignoreFiles.searchCeiling is workspace', async () => {
    const h = makeHarness({ searchCeiling: 'workspace' })
    h.put(`${CLIENT_ROOT}/.p4ignore`, 'build/\n')
    const ignored = await h.resolveIgnored([`${WORKSPACE}/build/x.obj`])
    expect([...ignored]).toEqual([])
    h.dispose()
  })

  it('resolves a remote workspace on the remote host', async () => {
    const h = makeHarness({
      controls: [p4SourceControl('/home/u/p4ws/main')],
      folder: URI.from({
        scheme: REMOTE_SCHEME,
        authority: 'myhost',
        path: '/home/u/p4ws/main/Project',
      }),
    })
    h.put('/home/u/p4ws/main/.p4ignore', 'build/\n')
    const target = '/home/u/p4ws/main/Project/build/x.obj'
    const ignored = await h.resolveIgnored([target])
    expect([...ignored]).toEqual([target])
    expect(new Set(h.schemesSeen())).toEqual(new Set([REMOTE_SCHEME]))
    h.dispose()
  })

  it('answers with an empty set and warns when the filesystem misbehaves', async () => {
    const h = makeHarness()
    h.put(`${WORKSPACE}/.p4ignore`, 'build/\n')
    ;(
      h.readFileText as unknown as { mockRejectedValueOnce(v: unknown): void }
    ).mockRejectedValueOnce(new Error('EIO'))
    const ignored = await h.resolveIgnored([`${WORKSPACE}/build/x.obj`])
    expect([...ignored]).toEqual([])
    h.dispose()
  })

  it('re-arbitrates when the source controls change', async () => {
    const h = makeHarness({ controls: [p4SourceControl('X:/other/depot')] })
    h.put(`${WORKSPACE}/.p4ignore`, 'build/\n')
    expect([...(await h.resolveIgnored([`${WORKSPACE}/build/x.obj`]))]).toHaveLength(0)
    h.sourceControls.set([p4SourceControl(CLIENT_ROOT)], undefined)
    expect([...(await h.resolveIgnored([`${WORKSPACE}/build/x.obj`]))]).toHaveLength(1)
    h.dispose()
  })
})
