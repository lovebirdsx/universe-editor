/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/renderer/workbench/remote/remoteTree.ts
 *--------------------------------------------------------------------------------------------*/

import { REMOTE_SCHEME, URI } from '@universe-editor/platform'
import { describe, expect, it } from 'vitest'
import type { WslDistroDto } from '../../../../shared/ipc/remoteStatusService.js'
import { buildRemoteTree } from '../remoteTree.js'

function remoteUri(authority: string, path: string): URI {
  return URI.from({ scheme: REMOTE_SCHEME, authority, path })
}

function distro(name: string, extra?: Partial<Omit<WslDistroDto, 'name'>>): WslDistroDto {
  return { name, isDefault: false, isRunning: false, version: 2, ...extra }
}

describe('buildRemoteTree', () => {
  it('routes ssh targets and wsl distros into their own groups', () => {
    const tree = buildRemoteTree({
      sshTargets: [{ host: 'prod', manual: false }],
      wslDistros: [distro('Ubuntu-24.04', { isDefault: true })],
      connections: [],
      recents: [],
    })
    expect(tree.groups.map((g) => g.id)).toEqual(['ssh', 'wsl'])
    expect(tree.groups[0]?.targets.map((t) => t.authority)).toEqual(['prod'])
    expect(tree.groups[1]?.targets.map((t) => t.authority)).toEqual(['wsl+ubuntu-24.04'])
  })

  it('matches a mixed-case wsl authority to its distro target without duplicating', () => {
    const folder = remoteUri('wsl+Ubuntu-24.04', '/home/x/work')
    const tree = buildRemoteTree({
      sshTargets: [],
      wslDistros: [distro('Ubuntu-24.04', { isDefault: true, isRunning: true })],
      connections: [{ authority: 'wsl+Ubuntu-24.04', state: 'connected' }],
      recents: [{ folder, name: 'work', lastOpened: 42 }],
    })
    const wsl = tree.groups[1]!
    expect(wsl.targets).toHaveLength(1)
    const target = wsl.targets[0]!
    expect(target.authority).toBe('wsl+ubuntu-24.04')
    expect(target.kind).toBe('wslTarget')
    expect(target.state).toBe('connected')
    expect(target.isDefault).toBe(true)
    expect(target.isRunning).toBe(true)
    expect(target.recents).toHaveLength(1)
    expect(target.recents[0]?.label).toBe('work')
    expect(target.recents[0]?.description).toBe('/home/x')
  })

  it('synthesizes a connection row for an authority missing from the enum', () => {
    const tree = buildRemoteTree({
      sshTargets: [],
      wslDistros: [],
      connections: [{ authority: 'e2e-local', state: 'connected' }],
      recents: [],
    })
    const ssh = tree.groups[0]!
    expect(ssh.targets).toHaveLength(1)
    expect(ssh.targets[0]).toMatchObject({ kind: 'connection', authority: 'e2e-local' })
  })

  it('synthesizes a target from a recent-only authority, kind by authority type', () => {
    const sshRecent = remoteUri('prod', '/srv/app')
    const wslRecent = remoteUri('wsl+Ubuntu-24.04', '/home/u')
    const tree = buildRemoteTree({
      sshTargets: [],
      wslDistros: [],
      connections: [],
      recents: [
        { folder: sshRecent, name: 'app', lastOpened: 1 },
        { folder: wslRecent, name: 'u', lastOpened: 2 },
      ],
    })
    const ssh = tree.groups[0]!
    const wsl = tree.groups[1]!
    expect(ssh.targets[0]?.kind).toBe('sshTarget')
    expect(ssh.targets[0]?.authority).toBe('prod')
    expect(wsl.targets[0]?.kind).toBe('wslTarget')
    expect(wsl.targets[0]?.authority).toBe('wsl+ubuntu-24.04')
  })

  it('sorts recents by lastOpened descending and filters non-remote recents', () => {
    const tree = buildRemoteTree({
      sshTargets: [{ host: 'prod', manual: false }],
      wslDistros: [],
      connections: [],
      recents: [
        { folder: remoteUri('prod', '/a'), name: 'older', lastOpened: 1 },
        { folder: remoteUri('prod', '/b'), name: 'newer', lastOpened: 3 },
        { folder: remoteUri('prod', '/c'), name: 'mid', lastOpened: 2 },
        { folder: URI.from({ scheme: 'file', path: '/local' }), name: 'local', lastOpened: 9 },
      ],
    })
    const target = tree.groups[0]!.targets[0]!
    expect(target.recents.map((r) => r.label)).toEqual(['newer', 'mid', 'older'])
  })

  it('sorts targets by label within a group', () => {
    const tree = buildRemoteTree({
      sshTargets: [
        { host: 'zeta', manual: false },
        { host: 'alpha', manual: true },
      ],
      wslDistros: [],
      connections: [],
      recents: [],
    })
    expect(tree.groups[0]?.targets.map((t) => t.label)).toEqual(['alpha', 'zeta'])
  })

  it('renders Windows remote recent descriptions as display paths', () => {
    const tree = buildRemoteTree({
      sshTargets: [{ host: 'winbox', manual: false }],
      wslDistros: [],
      connections: [],
      recents: [
        { folder: remoteUri('winbox', '/E:/workspace/foo'), name: 'foo', lastOpened: 4 },
        { folder: remoteUri('winbox', '/E:/foo'), name: 'root', lastOpened: 3 },
        { folder: remoteUri('winbox', '/home/x/proj'), name: 'posix', lastOpened: 2 },
        { folder: remoteUri('winbox', '/proj'), name: 'slashroot', lastOpened: 1 },
      ],
    })
    const byLabel = new Map(
      tree.groups[0]!.targets[0]!.recents.map((r) => [r.label, r.description]),
    )
    expect(byLabel.get('foo')).toBe('E:\\workspace')
    expect(byLabel.get('root')).toBe('E:\\')
    expect(byLabel.get('posix')).toBe('/home/x')
    expect(byLabel.get('slashroot')).toBe('/')
  })
})
