/*---------------------------------------------------------------------------------------------
 *  Tests for TerminalManagerService — mocks the cross-process ITerminalService proxy
 *  and drives its events via Emitters. No xterm / DOM involved.
 *--------------------------------------------------------------------------------------------*/

import { beforeEach, describe, expect, it } from 'vitest'
import {
  Emitter,
  type IConfigurationService,
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
import { TerminalManagerService } from '../TerminalManagerService.js'

interface Harness {
  manager: TerminalManagerService
  onData: Emitter<ITerminalDataEvent>
  onExit: Emitter<ITerminalExitEvent>
  created: Array<{ info: ITerminalCreatedInfo; spec: ITerminalSpawnSpec }>
  released: string[]
  inputs: Array<{ id: string; data: string }>
}

function makeStorage(): IStorageService {
  const store = new Map<string, unknown>()
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
): Harness {
  const onData = new Emitter<ITerminalDataEvent>()
  const onExit = new Emitter<ITerminalExitEvent>()
  const onTitleChange = new Emitter<ITerminalTitleEvent>()
  const created: Harness['created'] = []
  const released: string[] = []
  const inputs: Harness['inputs'] = []
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
      inputs.push({ id, data })
      return Promise.resolve()
    },
    resize: () => Promise.resolve(),
    kill: () => Promise.resolve(),
    list: () => Promise.resolve(created.map((c) => c.info)),
    release: (id) => {
      released.push(id)
      return Promise.resolve()
    },
  }

  const workspace = {
    current: cwd ? { folder: { fsPath: cwd } } : undefined,
  } as unknown as IWorkspaceService

  const loggerService = {
    createLogger: () => ({
      trace() {},
      debug() {},
      info() {},
      warn() {},
      error() {},
    }),
  } as unknown as ILoggerService

  const manager = new TerminalManagerService(
    terminal,
    workspace,
    loggerService,
    makeStorage(),
    makeConfig(configOverrides),
  )
  return { manager, onData, onExit, created, released, inputs }
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

  it('omits cwd when no workspace is open', async () => {
    const noWs = makeHarness(null)
    await noWs.manager.newTerminal()
    expect(noWs.created[0]!.spec.cwd).toBeUndefined()
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
})
