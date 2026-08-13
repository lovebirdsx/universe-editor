/*---------------------------------------------------------------------------------------------
 *  Routing tests for the terminal thin shell: local vs remote dispatch, id
 *  mapping, event merging, and permanent-close exit synthesis. Uses a fake local
 *  PtySpawner and a fake remote terminal service (no native module, no channel).
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  Emitter,
  URI,
  type IDisposable,
  type ITerminalCreatedInfo,
  type ITerminalDataEvent,
  type ITerminalExitEvent,
  type ITerminalProfile,
  type ITerminalProfilesRequest,
  type ITerminalService,
  type ITerminalSpawnSpec,
  type ITerminalTitleEvent,
} from '@universe-editor/platform'
import type { IPty } from '@lydell/node-pty'
import type { PtySpawner } from '@universe-editor/node-services'
import { TerminalMainService, type IRemoteTerminalEndpoint } from '../terminalMainService.js'

class FakePty implements IPty {
  cols = 80
  rows = 24
  process = 'fake'
  handleFlowControl = false
  constructor(readonly pid: number) {}
  readonly onData = (): IDisposable => ({ dispose: () => {} })
  readonly onExit = (): IDisposable => ({ dispose: () => {} })
  resize(): void {}
  clear(): void {}
  write(): void {}
  kill(): void {}
  pause(): void {}
  resume(): void {}
}

interface RemoteHarness {
  service: ITerminalService
  onData: Emitter<ITerminalDataEvent>
  onExit: Emitter<ITerminalExitEvent>
  onClose: Emitter<void>
  created: ITerminalSpawnSpec[]
  inputs: Array<{ id: string; data: string }>
  resizes: Array<{ id: string; cols: number; rows: number }>
  killed: string[]
  released: string[]
}

function makeRemoteHarness(): RemoteHarness {
  const onData = new Emitter<ITerminalDataEvent>()
  const onExit = new Emitter<ITerminalExitEvent>()
  const onTitleChange = new Emitter<ITerminalTitleEvent>()
  const onClose = new Emitter<void>()
  const created: ITerminalSpawnSpec[] = []
  const inputs: RemoteHarness['inputs'] = []
  const resizes: RemoteHarness['resizes'] = []
  const killed: string[] = []
  const released: string[] = []

  const service: ITerminalService = {
    _serviceBrand: undefined,
    onData: onData.event,
    onExit: onExit.event,
    onTitleChange: onTitleChange.event,
    create: async (spec) => {
      created.push(spec)
      return { id: 'remote-uuid-1', pid: 500, shell: spec.shell ?? '/bin/sh', name: 'remote' }
    },
    getProfiles: async (): Promise<readonly ITerminalProfile[]> => [],
    input: (id, data) => {
      inputs.push({ id, data })
      return Promise.resolve()
    },
    resize: (id, cols, rows) => {
      resizes.push({ id, cols, rows })
      return Promise.resolve()
    },
    kill: (id) => {
      killed.push(id)
      return Promise.resolve()
    },
    list: async (): Promise<readonly ITerminalCreatedInfo[]> => [
      { id: 'remote-uuid-1', pid: 500, shell: '/bin/sh', name: 'remote' },
    ],
    release: (id) => {
      released.push(id)
      return Promise.resolve()
    },
  }
  return { service, onData, onExit, onClose, created, inputs, resizes, killed, released }
}

interface LocalHarness {
  remote: RemoteHarness
  localSpawns: Array<{ file: string; opts: { cwd: string | undefined } }>
  svc: TerminalMainService
}

function makeLocalHarness(): LocalHarness {
  const remote = makeRemoteHarness()
  const localSpawns: LocalHarness['localSpawns'] = []
  const localSpawner: PtySpawner = (file, _args, opts) => {
    localSpawns.push({ file, opts: { cwd: opts.cwd } })
    return new FakePty(777)
  }
  const remoteFactory = async (authority: string): Promise<IRemoteTerminalEndpoint> => {
    void authority
    return { service: remote.service, onDidClose: remote.onClose.event }
  }
  const svc = new TerminalMainService(localSpawner, undefined, undefined, remoteFactory)
  return { remote, localSpawns, svc }
}

const remoteCwd = () =>
  URI.from({ scheme: 'remote-ssh', authority: 'e2e-local', path: '/ws' }).toJSON()

describe('TerminalMainService routing', () => {
  it('routes a file cwd to the local pty host', async () => {
    const { svc, localSpawns } = makeLocalHarness()
    const cwd = tmpdir()
    const info = await svc.create({ cwd: URI.file(cwd).toJSON(), shell: 'bash' })
    expect(info.id).not.toContain('remote:')
    expect(localSpawns).toHaveLength(1)
    expect(path.normalize(localSpawns[0]!.opts.cwd!)).toBe(path.normalize(cwd))
  })

  it('routes a remote-ssh cwd to the remote terminal service with the cwd URI intact', async () => {
    const { svc, remote } = makeLocalHarness()
    const info = await svc.create({ cwd: remoteCwd(), shell: 'bash' })
    expect(info.id).toBe('remote:e2e-local:remote-uuid-1')
    expect(remote.created).toHaveLength(1)
    expect(URI.revive(remote.created[0]!.cwd)?.scheme).toBe('remote-ssh')
  })

  it('maps input/resize/kill/release by the mapped id back to the remote id', async () => {
    const { svc, remote } = makeLocalHarness()
    const info = await svc.create({ cwd: remoteCwd() })
    await svc.input(info.id, 'ls\n')
    await svc.resize(info.id, 100, 30)
    await svc.kill(info.id)
    await svc.release(info.id)
    expect(remote.inputs).toEqual([{ id: 'remote-uuid-1', data: 'ls\n' }])
    expect(remote.resizes).toEqual([{ id: 'remote-uuid-1', cols: 100, rows: 30 }])
    expect(remote.killed).toEqual(['remote-uuid-1'])
    expect(remote.released).toEqual(['remote-uuid-1'])
  })

  it('merges remote onData/onExit events back under the mapped id', async () => {
    const { svc, remote } = makeLocalHarness()
    const info = await svc.create({ cwd: remoteCwd() })
    const data: ITerminalDataEvent[] = []
    const exits: ITerminalExitEvent[] = []
    svc.onData((e) => data.push(e))
    svc.onExit((e) => exits.push(e))

    remote.onData.fire({ id: 'remote-uuid-1', data: 'hi' })
    expect(data).toEqual([{ id: info.id, data: 'hi' }])

    remote.onExit.fire({ id: 'remote-uuid-1', exitCode: 7 })
    expect(exits).toEqual([{ id: info.id, exitCode: 7 }])
  })

  it('fires onExit for live terminals when the connection closes permanently', async () => {
    const { svc, remote } = makeLocalHarness()
    const info = await svc.create({ cwd: remoteCwd() })
    const exits: ITerminalExitEvent[] = []
    svc.onExit((e) => exits.push(e))

    remote.onClose.fire()

    expect(exits).toEqual([{ id: info.id, exitCode: 0 }])
  })

  it('routes getProfiles to the remote host when the folder is remote', async () => {
    const { svc, remote } = makeLocalHarness()
    let remoteProfileCalls = 0
    const original = remote.service.getProfiles
    remote.service.getProfiles = async (request: ITerminalProfilesRequest) => {
      remoteProfileCalls++
      void request
      return []
    }
    await svc.getProfiles({ folder: remoteCwd() })
    expect(remoteProfileCalls).toBe(1)
    // Local getProfiles still goes to the local host (fake spawner path).
    await svc.getProfiles({})
    expect(remoteProfileCalls).toBe(1)
    remote.service.getProfiles = original
  })
})
