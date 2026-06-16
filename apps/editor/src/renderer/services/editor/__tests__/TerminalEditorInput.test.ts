/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/renderer/services/editor/TerminalEditorInput.ts
 *
 *  Focus: serialize stores respawn spec (not the dead terminalId), and
 *  deserialize respawns a fresh editor pty whose id binds onto the observable.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import {
  IInstantiationService,
  InstantiationService,
  ServiceCollection,
  observableValue,
  type ISettableObservable,
  type ServicesAccessor,
} from '@universe-editor/platform'
import { TerminalEditorInput } from '../TerminalEditorInput.js'
import {
  ITerminalManagerService,
  type ITerminalManagerService as ITerminalManagerServiceType,
  type ITerminalNewSpec,
} from '../../terminal/TerminalManagerService.js'
import type { ITerminalCreatedInfo } from '../../../../shared/ipc/terminalService.js'

interface ManagerHarness {
  service: ITerminalManagerServiceType
  created: ITerminalNewSpec[]
  closed: string[]
  terminals: ISettableObservable<readonly ITerminalCreatedInfo[]>
  nextId: () => string
}

function makeManager(): ManagerHarness {
  const created: ITerminalNewSpec[] = []
  const closed: string[] = []
  const terminals = observableValue<readonly ITerminalCreatedInfo[]>('test.terminals', [])
  let counter = 0
  const nextId = () => `t${counter++}`

  const service = {
    _serviceBrand: undefined,
    terminals,
    panelTerminals: observableValue<readonly ITerminalCreatedInfo[]>('test.panel', []),
    terminalGroups: observableValue('test.groups', []),
    activeGroupId: observableValue<string | null>('test.activeGroup', null),
    activeTerminalId: observableValue<string | null>('test.active', null),
    onFocusRequest: () => ({ dispose() {} }),
    onDidTerminalExit: () => ({ dispose() {} }),
    onDidRemoveTerminal: () => ({ dispose() {} }),
    async newTerminal(spec?: ITerminalNewSpec): Promise<string | null> {
      created.push(spec ?? {})
      const id = nextId()
      const info: ITerminalCreatedInfo = {
        id,
        pid: 1000,
        shell: spec?.shell ?? 'bash',
        name: spec?.shell ?? 'bash',
      }
      terminals.set([...terminals.get(), info], undefined)
      return id
    },
    async splitTerminal(): Promise<string | null> {
      return null
    },
    closeTerminal(id: string) {
      closed.push(id)
    },
    setActiveTerminal() {},
    attach: () => ({ dispose() {} }),
    input() {},
    resize() {},
    focus() {},
    async load() {},
  } as unknown as ITerminalManagerServiceType

  return { service, created, closed, terminals, nextId }
}

function makeAccessor(harness: ManagerHarness): {
  accessor: ServicesAccessor
  inst: IInstantiationService
} {
  const services = new ServiceCollection()
  services.set(ITerminalManagerService, harness.service)
  const inst = new InstantiationService(services)
  const accessor: ServicesAccessor = { get: (id) => inst.invokeFunction((a) => a.get(id)) }
  return { accessor, inst }
}

describe('TerminalEditorInput', () => {
  it('serialize persists label + shell/cwd, never the terminalId', () => {
    const h = makeManager()
    const { inst } = makeAccessor(h)
    const input = inst.createInstance(TerminalEditorInput, 't-live', 'pwsh', {
      shell: 'pwsh',
      cwd: '/work',
    })
    const data = JSON.parse(input.serialize()) as Record<string, unknown>
    expect(data).toEqual({ label: 'pwsh', shell: 'pwsh', cwd: '/work' })
    expect(data['terminalId']).toBeUndefined()
  })

  it('live input binds the terminalId synchronously', () => {
    const h = makeManager()
    const { inst } = makeAccessor(h)
    const input = inst.createInstance(TerminalEditorInput, 't-live', 'bash', undefined)
    expect(input.terminalId.get()).toBe('t-live')
    expect(h.created).toHaveLength(0)
  })

  it('deserialize respawns a fresh editor pty and binds its id', async () => {
    const h = makeManager()
    const { accessor } = makeAccessor(h)
    const restored = TerminalEditorInput.deserialize(
      JSON.stringify({ label: 'pwsh', shell: 'pwsh', cwd: '/work' }),
      accessor,
    )
    expect(restored).not.toBeNull()
    // Respawn is async; id is undefined until the new pty is ready.
    expect(restored!.terminalId.get()).toBeUndefined()
    await Promise.resolve()
    await Promise.resolve()
    expect(h.created).toHaveLength(1)
    expect(h.created[0]).toMatchObject({ target: 'editor', shell: 'pwsh', cwd: '/work' })
    expect(restored!.terminalId.get()).toBe('t0')
  })

  it('disposing before the respawn resolves closes the late terminal', async () => {
    const h = makeManager()
    const { accessor } = makeAccessor(h)
    const restored = TerminalEditorInput.deserialize(JSON.stringify({ label: 'bash' }), accessor)!
    restored.dispose()
    await Promise.resolve()
    await Promise.resolve()
    // The pty that finished spawning after dispose must be released, not leaked.
    expect(h.closed).toContain('t0')
  })

  it('deserialize rejects malformed payloads', () => {
    const h = makeManager()
    const { accessor } = makeAccessor(h)
    expect(TerminalEditorInput.deserialize('not-json', accessor)).toBeNull()
    expect(TerminalEditorInput.deserialize(42 as unknown, accessor)).toBeNull()
  })
})
