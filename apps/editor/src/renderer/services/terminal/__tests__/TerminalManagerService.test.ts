/*---------------------------------------------------------------------------------------------
 *  Tests for TerminalManagerService — mocks the cross-process ITerminalService proxy
 *  and drives its events via Emitters. No xterm / DOM involved.
 *--------------------------------------------------------------------------------------------*/

import { beforeEach, describe, expect, it } from 'vitest'
import {
  Emitter,
  observableValue,
  URI,
  type HostPlatform,
  type IConfigurationService,
  type IEditorService,
  type IHostService,
  type ILoggerService,
  type IStorageService,
  type IWorkspaceService,
  StorageScope,
} from '@universe-editor/platform'
import {
  type ITerminalCreatedInfo,
  type ITerminalDataEvent,
  type ITerminalExitEvent,
  type ITerminalService,
  type ITerminalSpawnSpec,
  type ITerminalTitleEvent,
} from '../../../../shared/ipc/terminalService.js'
import type {
  IEnvironmentSnapshot,
  IEnvironmentSnapshotService,
} from '../../../../shared/ipc/environmentSnapshotService.js'
import { TerminalManagerService, computeTerminalCwd } from '../TerminalManagerService.js'
import { ConfigurationResolverService } from '../../configurationResolver/ConfigurationResolverService.js'

interface Harness {
  manager: TerminalManagerService
  onData: Emitter<ITerminalDataEvent>
  onExit: Emitter<ITerminalExitEvent>
  created: Array<{ info: ITerminalCreatedInfo; spec: ITerminalSpawnSpec }>
  released: string[]
  inputs: Array<{ id: string; data: string }>
  resizes: Array<{ id: string; cols: number; rows: number }>
  warnings: string[]
  terminalErrors: { input: Error | undefined; resize: Error | undefined }
}

function makeStorage(store: Map<string, unknown> = new Map<string, unknown>()): IStorageService {
  const onChangeWs = new Emitter<void>()
  return {
    _serviceBrand: undefined,
    onDidChangeWorkspaceScope: onChangeWs.event,
    get: <T>(_key: string, _scope: StorageScope) => Promise.resolve(store.get(_key) as T),
    set: (_key: string, value: unknown, _scope: StorageScope) => {
      store.set(_key, value)
      return Promise.resolve()
    },
    delete: (_key: string, _scope: StorageScope) => {
      store.delete(_key)
      return Promise.resolve()
    },
  } as unknown as IStorageService
}

function makeConfig(overrides: Record<string, unknown> = {}): IConfigurationService {
  return {
    _serviceBrand: undefined,
    get: <T>(key: string) => (overrides[key] as T) ?? ('' as unknown as T),
    onDidChangeConfiguration: new Emitter<never>().event,
  } as unknown as IConfigurationService
}

function makeHarness(
  cwd: string | null = '/work',
  configOverrides?: Record<string, unknown>,
  store?: Map<string, unknown>,
  opts?: { platform?: HostPlatform; userHome?: string; activeFile?: string },
): Harness {
  const onData = new Emitter<ITerminalDataEvent>()
  const onExit = new Emitter<ITerminalExitEvent>()
  const onTitleChange = new Emitter<ITerminalTitleEvent>()
  const created: Harness['created'] = []
  const released: string[] = []
  const inputs: Harness['inputs'] = []
  const resizes: Harness['resizes'] = []
  const warnings: string[] = []
  const terminalErrors: Harness['terminalErrors'] = { input: undefined, resize: undefined }
  let nextId = 0

  const terminal: ITerminalService = {
    _serviceBrand: undefined,
    onData: onData.event,
    onExit: onExit.event,
    onTitleChange: onTitleChange.event,
    create: (spec) => {
      const info: ITerminalCreatedInfo = {
        id: `t${nextId++}`,
        pid: 100 + nextId,
        shell: spec.shell ?? 'bash',
        name: spec.shell ?? 'bash',
      }
      created.push({ info, spec })
      return Promise.resolve(info)
    },
    input: (id, data) => {
      if (terminalErrors.input) return Promise.reject(terminalErrors.input)
      inputs.push({ id, data })
      return Promise.resolve()
    },
    resize: (id, cols, rows) => {
      if (terminalErrors.resize) return Promise.reject(terminalErrors.resize)
      resizes.push({ id, cols, rows })
      return Promise.resolve()
    },
    kill: () => Promise.resolve(),
    list: () => Promise.resolve(created.map((c) => c.info)),
    release: (id) => {
      released.push(id)
      return Promise.resolve()
    },
  }

  const workspace = {
    current: cwd ? { folder: URI.file(cwd), name: 'work' } : null,
  } as unknown as IWorkspaceService

  const loggerService = {
    createLogger: () => ({
      trace() {},
      debug() {},
      info() {},
      warn(message: string) {
        warnings.push(message)
      },
      error() {},
    }),
  } as unknown as ILoggerService

  const host = {
    _serviceBrand: undefined,
    platform: opts?.platform ?? ('linux' as HostPlatform),
  } as unknown as IHostService

  const editor = {
    _serviceBrand: undefined,
    activeEditor: observableValue(
      'activeEditor',
      opts?.activeFile ? ({ resource: URI.file(opts.activeFile) } as never) : undefined,
    ),
  } as unknown as IEditorService

  const snapshot: IEnvironmentSnapshot = {
    userHome: opts?.userHome ?? '/home/tester',
    cwd: '/main/cwd',
    env: { FOO: 'bar' },
  }
  const envSnapshot: IEnvironmentSnapshotService = {
    _serviceBrand: undefined,
    getSnapshot: () => Promise.resolve(snapshot),
  }

  const config = makeConfig(configOverrides)
  const resolver = new ConfigurationResolverService(workspace, editor, config, host, envSnapshot)

  const manager = new TerminalManagerService(
    terminal,
    workspace,
    loggerService,
    makeStorage(store),
    config,
    host,
    resolver,
    envSnapshot,
  )
  return { manager, onData, onExit, created, released, inputs, resizes, warnings, terminalErrors }
}

describe('TerminalManagerService', () => {
  let h: Harness
  beforeEach(() => {
    h = makeHarness()
  })

  it('newTerminal creates with workspace cwd and activates it', async () => {
    const id = await h.manager.newTerminal()
    expect(id).toBe('t0')
    expect(h.created[0]!.spec.cwd).toBe('/work')
    expect(h.manager.terminals.get().map((t) => t.id)).toEqual(['t0'])
    expect(h.manager.activeTerminalId.get()).toBe('t0')
  })

  it('falls back to the user home when no workspace is open', async () => {
    const noWs = makeHarness(null, undefined, undefined, { userHome: '/home/tester' })
    await noWs.manager.newTerminal()
    expect(noWs.created[0]!.spec.cwd).toBe('/home/tester')
  })

  it('omits cwd entirely when there is neither workspace nor home', async () => {
    const bare = makeHarness(null, undefined, undefined, { userHome: '' })
    await bare.manager.newTerminal()
    expect(bare.created[0]!.spec.cwd).toBeUndefined()
  })

  it('expands ${workspaceFolder} in terminal.integrated.cwd', async () => {
    const withConfig = makeHarness(
      'G:/aki_3.6/Source/Client/TypeScript',
      { 'terminal.integrated.cwd': '${workspaceFolder}/Src/UniverseEditor' },
      undefined,
      { platform: 'win32' },
    )
    await withConfig.manager.newTerminal()
    expect(withConfig.created[0]!.spec.cwd).toBe(
      'G:/aki_3.6/Source/Client/TypeScript/Src/UniverseEditor',
    )
  })

  it('falls back to home when terminal.integrated.cwd needs a workspace but none is open', async () => {
    const noWs = makeHarness(
      null,
      { 'terminal.integrated.cwd': '${workspaceFolder}/Src/UniverseEditor' },
      undefined,
      { userHome: '/home/tester' },
    )
    await noWs.manager.newTerminal()
    // Variable resolution throws (no folder); consumer degrades then falls back.
    expect(noWs.created[0]!.spec.cwd).toBe('/home/tester')
  })

  it('routes onData to the attached writer', async () => {
    const id = await h.manager.newTerminal()
    const chunks: string[] = []
    h.manager.attach(id!, (d) => chunks.push(d))
    h.onData.fire({ id: id!, data: 'hi' })
    expect(chunks).toEqual(['hi'])
  })

  it('buffers output until a writer attaches, then flushes', async () => {
    const id = await h.manager.newTerminal()
    h.onData.fire({ id: id!, data: 'early' })
    const chunks: string[] = []
    h.manager.attach(id!, (d) => chunks.push(d))
    expect(chunks).toEqual(['early'])
  })

  it('detach stops routing', async () => {
    const id = await h.manager.newTerminal()
    const chunks: string[] = []
    const sub = h.manager.attach(id!, (d) => chunks.push(d))
    sub.dispose()
    h.onData.fire({ id: id!, data: 'x' })
    expect(chunks).toEqual([])
  })

  it('onExit writes an exit notice and drops the terminal', async () => {
    const id = await h.manager.newTerminal()
    const chunks: string[] = []
    h.manager.attach(id!, (d) => chunks.push(d))
    h.onExit.fire({ id: id!, exitCode: 0 })
    expect(chunks.join('')).toContain('exited with code 0')
    expect(h.manager.terminals.get()).toHaveLength(0)
    expect(h.manager.activeTerminalId.get()).toBeNull()
  })

  it('closeTerminal releases the process and drops it', async () => {
    const id = await h.manager.newTerminal()
    h.manager.closeTerminal(id!)
    expect(h.released).toContain(id)
    expect(h.manager.terminals.get()).toHaveLength(0)
  })

  it('forwards input to the proxy by id', async () => {
    const id = await h.manager.newTerminal()
    h.manager.input(id!, 'ls\n')
    expect(h.inputs).toEqual([{ id, data: 'ls\n' }])
  })

  it('does not forward input or resize after a terminal has exited locally', async () => {
    const id = await h.manager.newTerminal()
    h.onExit.fire({ id: id!, exitCode: 0 })

    h.manager.input(id!, 'late')
    h.manager.resize(id!, 80, 24)

    expect(h.inputs).toEqual([])
    expect(h.resizes).toEqual([])
  })

  it('swallows stale unknown-terminal rejections from late input and resize IPC', async () => {
    const id = await h.manager.newTerminal()
    h.terminalErrors.input = new Error(`Terminal: unknown terminal ${id}`)
    h.terminalErrors.resize = new Error(`Terminal: unknown terminal ${id}`)

    h.manager.input(id!, 'late')
    h.manager.resize(id!, 80, 24)
    await Promise.resolve()

    expect(h.warnings).toEqual([])
  })

  it('keeps terminals isolated — data for one does not reach the other', async () => {
    const a = await h.manager.newTerminal()
    const b = await h.manager.newTerminal()
    const aChunks: string[] = []
    const bChunks: string[] = []
    h.manager.attach(a!, (d) => aChunks.push(d))
    h.manager.attach(b!, (d) => bChunks.push(d))
    h.onData.fire({ id: b!, data: 'toB' })
    expect(aChunks).toEqual([])
    expect(bChunks).toEqual(['toB'])
  })

  it('activates the previous terminal when the active one is closed', async () => {
    const a = await h.manager.newTerminal()
    const b = await h.manager.newTerminal()
    expect(h.manager.activeTerminalId.get()).toBe(b)
    h.manager.closeTerminal(b!)
    expect(h.manager.activeTerminalId.get()).toBe(a)
  })

  it('panelTerminals only includes panel-target terminals', async () => {
    const panelId = await h.manager.newTerminal({ target: 'panel' })
    const editorId = await h.manager.newTerminal({ target: 'editor' })
    const panel = h.manager.panelTerminals.get()
    expect(panel.map((t) => t.id)).toContain(panelId)
    expect(panel.map((t) => t.id)).not.toContain(editorId)
    expect(h.manager.terminals.get()).toHaveLength(2)
  })

  it('editor terminal does not update activeTerminalId', async () => {
    const panelId = await h.manager.newTerminal({ target: 'panel' })
    await h.manager.newTerminal({ target: 'editor' })
    expect(h.manager.activeTerminalId.get()).toBe(panelId)
  })

  it('onDidTerminalExit fires with correct target before terminal is removed', async () => {
    const id = await h.manager.newTerminal({ target: 'editor' })
    const events: Array<{ id: string; target: string }> = []
    h.manager.onDidTerminalExit((e) => events.push({ id: e.id, target: e.target }))
    h.onExit.fire({ id: id!, exitCode: 0 })
    expect(events).toEqual([{ id, target: 'editor' }])
    expect(h.manager.terminals.get()).toHaveLength(0)
  })

  it('uses config shell when no spec shell provided', async () => {
    const withConfig = makeHarness('/work', { 'terminal.integrated.shell': 'zsh' })
    await withConfig.manager.newTerminal()
    expect(withConfig.created[0]!.spec.shell).toBe('zsh')
  })

  it('onDidRemoveTerminal fires once on user close', async () => {
    const id = await h.manager.newTerminal()
    const removed: string[] = []
    h.manager.onDidRemoveTerminal(({ id }) => removed.push(id))
    h.manager.closeTerminal(id!)
    expect(removed).toEqual([id])
  })

  it('onDidRemoveTerminal fires once on process exit', async () => {
    const id = await h.manager.newTerminal()
    const removed: string[] = []
    h.manager.onDidRemoveTerminal(({ id }) => removed.push(id))
    h.onExit.fire({ id: id!, exitCode: 0 })
    expect(removed).toEqual([id])
  })

  describe('split groups', () => {
    it('newTerminal opens each terminal in its own group', async () => {
      const a = await h.manager.newTerminal()
      const b = await h.manager.newTerminal()
      const groups = h.manager.terminalGroups.get()
      expect(groups.map((g) => g.terminals)).toEqual([[a], [b]])
      expect(h.manager.activeGroupId.get()).toBe(groups[1]!.id)
    })

    it('splitTerminal adds a sibling into the active group and activates it', async () => {
      const a = await h.manager.newTerminal()
      const b = await h.manager.splitTerminal()
      const groups = h.manager.terminalGroups.get()
      expect(groups).toHaveLength(1)
      expect(groups[0]!.terminals).toEqual([a, b])
      expect(h.manager.activeTerminalId.get()).toBe(b)
      expect(h.manager.activeGroupId.get()).toBe(groups[0]!.id)
    })

    it('splitTerminal inserts after the active terminal within the group', async () => {
      const a = await h.manager.newTerminal()
      const b = await h.manager.splitTerminal()
      h.manager.setActiveTerminal(a!)
      const c = await h.manager.splitTerminal()
      expect(h.manager.terminalGroups.get()[0]!.terminals).toEqual([a, c, b])
    })

    it('splitTerminal with no active group falls back to a new group', async () => {
      const id = await h.manager.splitTerminal()
      const groups = h.manager.terminalGroups.get()
      expect(groups).toHaveLength(1)
      expect(groups[0]!.terminals).toEqual([id])
    })

    it('closing a split terminal keeps the group and activates a sibling', async () => {
      const a = await h.manager.newTerminal()
      const b = await h.manager.splitTerminal()
      h.manager.closeTerminal(b!)
      const groups = h.manager.terminalGroups.get()
      expect(groups).toHaveLength(1)
      expect(groups[0]!.terminals).toEqual([a])
      expect(h.manager.activeTerminalId.get()).toBe(a)
    })

    it('closing the last terminal of a group removes the group', async () => {
      const a = await h.manager.newTerminal()
      const b = await h.manager.newTerminal()
      h.manager.closeTerminal(b!)
      const groups = h.manager.terminalGroups.get()
      expect(groups.map((g) => g.terminals)).toEqual([[a]])
      expect(h.manager.activeGroupId.get()).toBe(groups[0]!.id)
      expect(h.manager.activeTerminalId.get()).toBe(a)
    })

    it('persists and restores split groups across a reload', async () => {
      const store = new Map<string, unknown>()
      const first = makeHarness('/work', undefined, store)
      await first.manager.newTerminal()
      await first.manager.splitTerminal()
      await first.manager.newTerminal()
      await first.manager.save()

      const second = makeHarness('/work', undefined, store)
      await second.manager.load()
      const groups = second.manager.terminalGroups.get()
      expect(groups.map((g) => g.terminals.length)).toEqual([2, 1])
    })
  })
})

describe('computeTerminalCwd', () => {
  it('uses an absolute resolved cwd as-is', () => {
    expect(computeTerminalCwd('/abs/dir', '/work', '/home', 'linux')).toBe('/abs/dir')
    expect(computeTerminalCwd('C:/abs', 'D:/work', 'D:/home', 'win32')).toBe('C:/abs')
  })

  it('joins a relative resolved cwd under the workspace root', () => {
    expect(computeTerminalCwd('src/app', '/work', '/home', 'linux')).toBe('/work/src/app')
  })

  it('falls back to the workspace root when the relative cwd has no root and there is one', () => {
    // A relative cwd always joins when a workspace exists, so exercise the empty case.
    expect(computeTerminalCwd(undefined, '/work', '/home', 'linux')).toBe('/work')
  })

  it('drops a relative cwd with no workspace, then falls back to home', () => {
    expect(computeTerminalCwd('src/app', undefined, '/home', 'linux')).toBe('/home')
  })

  it('falls back to home when there is no cwd and no workspace', () => {
    expect(computeTerminalCwd(undefined, undefined, '/home', 'linux')).toBe('/home')
  })

  it('returns undefined when nothing is available', () => {
    expect(computeTerminalCwd(undefined, undefined, undefined, 'linux')).toBeUndefined()
    expect(computeTerminalCwd('', undefined, undefined, 'linux')).toBeUndefined()
  })
})
