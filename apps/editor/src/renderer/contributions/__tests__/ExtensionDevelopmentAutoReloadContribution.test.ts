/*---------------------------------------------------------------------------------------------
 *  Tests for ExtensionDevelopmentAutoReloadContribution — arming resolves each
 *  dev extension's manifest main into a watched entry URI, matching watcher
 *  events debounce into a single host restart, restarts are serial with one
 *  coalesced re-run, the stat-confirm rejects watcher-warmup writes, the
 *  setting gates everything, and the spinning status entry / one-shot debugger
 *  notification bracket each restart.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it } from 'vitest'
import {
  Emitter,
  URI,
  UriIdentityService,
  type IFileChangeEvent,
  type IFileService,
  type IFileWatcherService,
  type IConfigurationService,
  type ILoggerService,
  type INotificationService,
} from '@universe-editor/platform'
import type { IExtensionDescriptionDto } from '@universe-editor/extensions-common'
import { EXTENSION_DEVELOPMENT_ENABLED_KEY } from '../../../shared/extensionDevelopment.js'
import { StatusBarService } from '../../services/statusbar/StatusBarService.js'
import type { IExtensionHostClientService } from '../../services/extensions/ExtensionHostClientService.js'
import type { IOutOfWorkspaceWatchService } from '../../services/files/outOfWorkspaceWatchService.js'
import {
  AUTO_RESTART_ON_CHANGE_SETTING,
  ExtensionDevelopmentAutoReloadContribution,
} from '../ExtensionDevelopmentAutoReloadContribution.js'

const ENTRY_URI = URI.file('/dev/ext-a/dist/extension.js')
const ENTRY_MANIFEST = JSON.stringify({ name: 'ext-a', main: './dist/extension.js' })

function dto(id: string, dev: boolean, hasMain = true): IExtensionDescriptionDto {
  return {
    id,
    name: id,
    activationEvents: [],
    contributes: {},
    hasMain,
    extensionLocation: `/dev/${id}`,
    extensionIsBuiltin: false,
    ...(dev ? { extensionIsUnderDevelopment: true } : {}),
  }
}

const tick = () => new Promise<void>((r) => setTimeout(r, 20))

function setup(opts?: {
  readonly devMode?: boolean
  readonly dtos?: readonly IExtensionDescriptionDto[]
  /** URI.toString() → package.json content. */
  readonly manifests?: Readonly<Record<string, string>>
  /** URI.toString() → mtime. */
  readonly mtimes?: Record<string, number>
  readonly setting?: boolean
}) {
  const devMode = opts?.devMode ?? true
  if (devMode) {
    ;(globalThis as Record<string, unknown>).window = {
      [EXTENSION_DEVELOPMENT_ENABLED_KEY]: true,
    }
  }

  let refreshes = 0
  let getContributionsCalls = 0
  let held: { promise: Promise<void>; resolve: () => void } | undefined
  const hostClient = {
    getContributions: () => {
      getContributionsCalls++
      return Promise.resolve(opts?.dtos ?? [dto('ext-a', true)])
    },
    refreshExtensions: () => {
      refreshes++
      return held ? held.promise : Promise.resolve()
    },
  } as unknown as IExtensionHostClientService

  const changeEmitter = new Emitter<readonly IFileChangeEvent[]>()
  const watcher = {
    onDidChangeFiles: changeEmitter.event,
  } as unknown as IFileWatcherService

  const watched: URI[] = []
  const outOfWorkspaceWatch = {
    watch: (uris: readonly URI[]) => {
      watched.push(...uris)
      return { dispose() {} }
    },
  } as unknown as IOutOfWorkspaceWatchService

  const manifests = opts?.manifests ?? {
    [URI.file('/dev/ext-a/package.json').toString()]: ENTRY_MANIFEST,
  }
  const mtimes = opts?.mtimes ?? { [ENTRY_URI.toString()]: Date.now() + 60_000 }
  const files = {
    readFileText: (uri: URI) => {
      const text = manifests[uri.toString()]
      return text === undefined ? Promise.reject(new Error('ENOENT')) : Promise.resolve(text)
    },
    stat: (uri: URI) => {
      const mtime = mtimes[uri.toString()]
      return mtime === undefined
        ? Promise.reject(new Error('ENOENT'))
        : Promise.resolve({ resource: uri, isFile: true, isDirectory: false, size: 1, mtime })
    },
  } as unknown as IFileService

  const config = {
    get: <T>(key: string, defaultValue?: T): T | undefined =>
      key === AUTO_RESTART_ON_CHANGE_SETTING
        ? ((opts?.setting ?? defaultValue) as T | undefined)
        : defaultValue,
  } as unknown as IConfigurationService

  const statusBar = new StatusBarService()

  const notifications: string[] = []
  const notificationService = {
    notify: (n: { message: string }) => {
      notifications.push(n.message)
      return { dispose() {} }
    },
  } as unknown as INotificationService

  const contrib = new ExtensionDevelopmentAutoReloadContribution(
    hostClient,
    watcher,
    outOfWorkspaceWatch,
    files,
    config,
    statusBar,
    notificationService,
    new UriIdentityService('linux'),
    undefined as unknown as ILoggerService,
  )
  contrib.debounceMs = 0

  const fire = (resource: URI) => changeEmitter.fire([{ type: 'modified', resource }])

  return {
    contrib,
    statusBar,
    notifications,
    watched,
    fire,
    get refreshes() {
      return refreshes
    },
    get getContributionsCalls() {
      return getContributionsCalls
    },
    holdRefresh() {
      let resolve!: () => void
      held = { promise: new Promise<void>((r) => (resolve = r)), resolve }
    },
    releaseRefresh() {
      const h = held
      held = undefined
      h?.resolve()
    },
  }
}

describe('ExtensionDevelopmentAutoReloadContribution', () => {
  afterEach(() => {
    delete (globalThis as Record<string, unknown>).window
  })

  it('does not arm outside extension-development mode', async () => {
    const env = setup({ devMode: false })
    await tick()
    expect(env.getContributionsCalls).toBe(0)
    expect(env.watched).toHaveLength(0)
    env.fire(ENTRY_URI)
    await tick()
    expect(env.refreshes).toBe(0)
    env.contrib.dispose()
  })

  it('watches the entry URI resolved from each dev extension manifest main', async () => {
    const env = setup({
      dtos: [dto('ext-a', true), dto('ext-b', true), dto('user-c', false), dto('ext-d', true)],
      manifests: {
        [URI.file('/dev/ext-a/package.json').toString()]: ENTRY_MANIFEST,
        [URI.file('/dev/ext-b/package.json').toString()]: JSON.stringify({ main: 'out/main.cjs' }),
        [URI.file('/dev/ext-d/package.json').toString()]: JSON.stringify({ name: 'ext-d' }),
      },
    })
    await tick()
    expect(env.watched.map((u) => u.toString())).toEqual([
      ENTRY_URI.toString(),
      URI.file('/dev/ext-b/out/main.cjs').toString(),
    ])
    env.contrib.dispose()
  })

  it('restarts the host once for a matching event', async () => {
    const env = setup()
    await tick()
    env.fire(ENTRY_URI)
    await tick()
    expect(env.refreshes).toBe(1)
    env.contrib.dispose()
  })

  it('collapses a burst of events into one restart', async () => {
    const env = setup()
    await tick()
    env.contrib.debounceMs = 30
    for (let i = 0; i < 5; i++) env.fire(ENTRY_URI)
    await new Promise<void>((r) => setTimeout(r, 100))
    expect(env.refreshes).toBe(1)
    env.contrib.dispose()
  })

  it('ignores events outside the watched entry directories', async () => {
    const env = setup()
    await tick()
    env.fire(URI.file('/dev/ext-a/src/index.ts'))
    env.fire(URI.file('/elsewhere/dist/extension.js'))
    await tick()
    expect(env.refreshes).toBe(0)
    env.contrib.dispose()
  })

  it('coalesces an event arriving mid-restart into one follow-up restart', async () => {
    const env = setup()
    await tick()
    env.holdRefresh()
    env.fire(ENTRY_URI)
    await tick()
    expect(env.refreshes).toBe(1)
    env.fire(ENTRY_URI)
    await tick()
    expect(env.refreshes).toBe(1)
    env.releaseRefresh()
    await tick()
    expect(env.refreshes).toBe(2)
    env.contrib.dispose()
  })

  it('skips the restart when the entry mtime predates arming (watcher warmup write)', async () => {
    const env = setup({ mtimes: { [ENTRY_URI.toString()]: 1 } })
    await tick()
    env.fire(ENTRY_URI)
    await tick()
    expect(env.refreshes).toBe(0)
    env.contrib.dispose()
  })

  it('does not restart when extensions.autoRestartOnChange is false', async () => {
    const env = setup({ setting: false })
    await tick()
    env.fire(ENTRY_URI)
    await tick()
    expect(env.refreshes).toBe(0)
    env.contrib.dispose()
  })

  it('shows a spinning status entry during the restart and notifies about the debugger once', async () => {
    const env = setup()
    await tick()
    env.holdRefresh()
    env.fire(ENTRY_URI)
    await tick()
    expect(env.refreshes).toBe(1)
    const entries = env.statusBar.entries.get()
    expect(entries).toHaveLength(1)
    expect(entries[0]?.entry.showProgress).toBe('spinning')

    env.releaseRefresh()
    await tick()
    expect(env.statusBar.entries.get()).toHaveLength(0)
    expect(env.notifications).toHaveLength(1)

    env.fire(ENTRY_URI)
    await tick()
    expect(env.refreshes).toBe(2)
    expect(env.notifications).toHaveLength(1)
    env.contrib.dispose()
  })
})
