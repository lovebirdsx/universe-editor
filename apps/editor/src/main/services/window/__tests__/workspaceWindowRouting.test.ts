/*---------------------------------------------------------------------------------------------
 *  Tests for the shared workspace → window routing helper (mobile gateway + triggers).
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest'
import { URI } from '@universe-editor/platform'
import {
  findWorkspaceHost,
  isSameWorkspace,
  listWorkspaceWindows,
  waitForWorkspaceHost,
  type WorkspaceHostDirectory,
} from '../workspaceWindowRouting.js'

const folder = 'X:/workspace'

describe('listWorkspaceWindows', () => {
  it('drops empty windows and keeps the remote authority', () => {
    const result = listWorkspaceWindows([
      { id: 1, folder: null, name: null },
      { id: 2, folder: URI.file(folder).toJSON(), name: 'workspace' },
      {
        id: 3,
        folder: URI.parse('vscode-remote://acme-host/X:/workspace').toJSON(),
        name: 'remote',
        remoteAuthority: 'acme-host',
      },
    ])
    expect(result).toHaveLength(2)
    expect(result[0]).toEqual({
      windowId: 2,
      folder: URI.file(folder).toString(),
      name: 'workspace',
    })
    expect(result[1]?.authority).toBe('acme-host')
  })
})

describe('isSameWorkspace', () => {
  it('compares local paths through the platform rules', () => {
    expect(
      isSameWorkspace(
        { folder: URI.file(folder).toString() },
        { folder: URI.file(folder).toString() },
      ),
    ).toBe(true)
    expect(
      isSameWorkspace(
        { folder: URI.file(folder).toString() },
        { folder: URI.file('X:/other').toString() },
      ),
    ).toBe(false)
  })

  it('separates schemes and authorities', () => {
    const remote = 'vscode-remote://acme-host/X:/workspace'
    expect(isSameWorkspace({ folder: URI.file(folder).toString() }, { folder: remote })).toBe(false)
    expect(
      isSameWorkspace(
        { folder: remote, authority: 'acme-host' },
        { folder: remote, authority: 'other-host' },
      ),
    ).toBe(false)
  })

  it('compares non-file paths case-sensitively even on a case-folding host', () => {
    const remote = (path: string): string =>
      URI.from({ scheme: 'remote-ssh', authority: 'acme-host', path }).toString()
    expect(
      isSameWorkspace({ folder: remote('/work/repo') }, { folder: remote('/work/repo') }),
    ).toBe(true)
    expect(
      isSameWorkspace({ folder: remote('/work/repo') }, { folder: remote('/work/Repo') }),
    ).toBe(false)
    expect(
      isSameWorkspace(
        { folder: remote('/work/repo') },
        {
          folder: URI.from({
            scheme: 'remote-ssh',
            authority: 'other',
            path: '/work/repo',
          }).toString(),
        },
      ),
    ).toBe(false)
  })
})

describe('waitForWorkspaceHost', () => {
  function directory(hasHost: (windowId: number) => boolean): WorkspaceHostDirectory {
    return {
      listOpenWorkspaces: () => [
        { windowId: 1, folder: URI.file(folder).toString(), name: 'workspace' },
      ],
      hasHost,
    }
  }

  it('returns immediately when the host is already registered', async () => {
    expect(
      findWorkspaceHost(
        directory(() => true),
        { folder: URI.file(folder).toString() },
      ),
    ).toBe(1)
    expect(
      await waitForWorkspaceHost(
        directory(() => true),
        {
          target: { folder: URI.file(folder).toString() },
          timeoutMs: 0,
        },
      ),
    ).toBe(1)
  })

  it('times out when the host never registers', async () => {
    let clock = 0
    const sleep = vi.fn(async () => {
      clock += 6
    })
    const now = () => clock
    const result = await waitForWorkspaceHost(
      directory(() => false),
      {
        target: { folder: URI.file(folder).toString() },
        timeoutMs: 10,
        pollIntervalMs: 5,
        now,
        sleep,
      },
    )
    expect(result).toBeUndefined()
    expect(sleep).toHaveBeenCalled()
  })
})
