/*---------------------------------------------------------------------------------------------
 *  Tests for remoteTreeDataSource — the RemoteTree -> ITreeDataSource adapter.
 *  Component-free, so it runs in the renderer-node project.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import { REMOTE_SCHEME, URI } from '@universe-editor/platform'
import type { WslDistroDto } from '../../../../shared/ipc/remoteStatusService.js'
import { buildRemoteTree } from '../remoteTree.js'
import {
  buildRemoteTreeSnapshot,
  createRemoteTreeDataSource,
  remoteNodeId,
  type RemoteNode,
} from '../remoteTreeDataSource.js'

const EMPTY_MESSAGE = 'No SSH targets.'

function remoteUri(authority: string, path: string): URI {
  return URI.from({ scheme: REMOTE_SCHEME, authority, path })
}

function distro(name: string): WslDistroDto {
  return { name, isDefault: false, isRunning: false, version: 2 }
}

function snapshotOf(input: Partial<Parameters<typeof buildRemoteTree>[0]> = {}) {
  return buildRemoteTreeSnapshot(
    buildRemoteTree({
      sshTargets: [],
      wslDistros: [],
      connections: [],
      recents: [],
      ...input,
    }),
    EMPTY_MESSAGE,
  )
}

const sourceOf = (input?: Partial<Parameters<typeof buildRemoteTree>[0]>) => {
  const snapshot = snapshotOf(input)
  return createRemoteTreeDataSource(() => snapshot)
}

describe('remoteNodeId', () => {
  it('namespaces each node kind so ids never collide', () => {
    const ids = [
      remoteNodeId({ kind: 'group', group: { id: 'ssh', targets: [] } }),
      remoteNodeId({
        kind: 'target',
        groupId: 'ssh',
        target: {
          kind: 'sshTarget',
          authority: 'ssh',
          label: 'ssh',
          state: undefined,
          manual: false,
          recents: [],
        },
      }),
      remoteNodeId({ kind: 'empty', groupId: 'ssh', message: EMPTY_MESSAGE }),
    ]
    expect(new Set(ids).size).toBe(3)
  })

  it('keys recents by authority so the same folder under two hosts stays distinct', () => {
    const folder = remoteUri('host-a', '/srv/app')
    const recent = { folder, label: 'app', description: '/srv', lastOpened: 1 }
    const a = remoteNodeId({ kind: 'recent', recent, authority: 'host-a' })
    const b = remoteNodeId({ kind: 'recent', recent, authority: 'host-b' })
    expect(a).not.toBe(b)
  })
})

describe('buildRemoteTreeSnapshot', () => {
  it('always roots the SSH group and hangs the empty hint under it', () => {
    const source = sourceOf()
    const roots = source.getRoots()
    expect(roots.map(remoteNodeId)).toEqual(['group:ssh'])
    const [ssh] = roots
    expect(ssh).toBeDefined()
    expect(source.hasChildren(ssh!)).toBe(true)
    const children = source.getChildren(ssh!) ?? []
    expect(children.map((c) => c.kind)).toEqual(['empty'])
    expect(children[0]).toMatchObject({ kind: 'empty', message: EMPTY_MESSAGE })
  })

  it('omits the WSL group until it has targets', () => {
    expect(sourceOf().getRoots().map(remoteNodeId)).toEqual(['group:ssh'])
    const withWsl = sourceOf({ wslDistros: [distro('Ubuntu')] })
    expect(withWsl.getRoots().map(remoteNodeId)).toEqual(['group:ssh', 'group:wsl'])
  })

  it('nests recents under their target and links parents both ways', () => {
    const folder = remoteUri('alice@host', '/srv/app')
    const source = sourceOf({
      sshTargets: [{ host: 'alice@host', manual: true }],
      recents: [{ folder, name: 'app', lastOpened: 10 }],
    })

    const group = source.getRoots()[0]!
    const target = (source.getChildren(group) ?? [])[0]!
    expect(target.kind).toBe('target')
    expect(source.hasChildren(target)).toBe(true)

    const recents = source.getChildren(target) ?? []
    expect(recents.map((r) => r.kind)).toEqual(['recent'])
    const recent = recents[0]!

    // getParent walks the rebuilt index — snapshots have no stable identity.
    expect(source.getParent?.(recent)).toBeDefined()
    expect(remoteNodeId(source.getParent!(recent)!)).toBe(remoteNodeId(target))
    expect(remoteNodeId(source.getParent!(target)!)).toBe('group:ssh')
    expect(source.getParent!(group)).toBeNull()
  })

  it('reports no children for a target without recents', () => {
    const source = sourceOf({ sshTargets: [{ host: 'bare@host', manual: false }] })
    const group = source.getRoots()[0]!
    const target = (source.getChildren(group) ?? [])[0]!
    expect(source.hasChildren(target)).toBe(false)
    expect(source.getChildren(target)).toEqual([])
  })

  it('serves the latest snapshot through the getter, not the one captured at build', () => {
    let snapshot = snapshotOf()
    const source = createRemoteTreeDataSource(() => snapshot)
    expect(source.getRoots()).toHaveLength(1)

    snapshot = snapshotOf({ wslDistros: [distro('Ubuntu')] })
    expect(source.getRoots().map(remoteNodeId)).toEqual(['group:ssh', 'group:wsl'])
  })

  it('returns empty children for an unknown node instead of throwing', () => {
    const source = sourceOf()
    const stray: RemoteNode = { kind: 'empty', groupId: 'wsl', message: 'x' }
    expect(source.hasChildren(stray)).toBe(false)
    expect(source.getChildren(stray)).toEqual([])
    expect(source.getParent?.(stray)).toBeNull()
  })
})
