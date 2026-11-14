/*---------------------------------------------------------------------------------------------
 *  Tests for the composite workspace + trigger id used by state, queue and IPC.
 *  Workspace identity is a URI string: file paths fold by host platform, remote
 *  paths compare case-sensitively (the remote filesystem decides, not Windows).
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import { getPathComparisonKey, URI } from '@universe-editor/platform'
import {
  canonicalTriggerKey,
  parseTriggerKey,
  triggerKeyBelongsToWorkspace,
  triggerKeyFor,
  workspaceComparisonKey,
} from '../triggerIdentity.js'

const fileUri = (path: string): string => URI.file(path).toString()
const remoteUri = (authority: string, path: string): string =>
  URI.from({ scheme: 'remote-ssh', authority, path }).toString()

describe('trigger identity', () => {
  it('builds a key from the normalized workspace plus the bare id', () => {
    const key = triggerKeyFor(fileUri('X:/workspace/one'), 'weekly', 'win32')
    expect(key).toBe(`${getPathComparisonKey('X:/workspace/one', 'win32')}\u0000weekly`)
    expect(parseTriggerKey(key)).toEqual({
      workspaceKey: getPathComparisonKey('X:/workspace/one', 'win32'),
      triggerId: 'weekly',
    })
  })

  it('gives the same trigger id distinct keys in different workspaces', () => {
    const left = triggerKeyFor(fileUri('X:/workspace/one'), 'weekly', 'win32')
    const right = triggerKeyFor(fileUri('X:/workspace/two'), 'weekly', 'win32')
    expect(left).not.toBe(right)
    expect(parseTriggerKey(left)?.triggerId).toBe('weekly')
    expect(parseTriggerKey(right)?.triggerId).toBe('weekly')
  })

  it('folds file path casing/separators through the kernel comparison key only', () => {
    expect(workspaceComparisonKey(fileUri('C:\\Work\\Repo'), 'win32')).toBe(
      getPathComparisonKey('c:/work/repo', 'win32'),
    )
    expect(workspaceComparisonKey(fileUri('/home/dev/repo'), 'linux')).toBe(
      getPathComparisonKey('/home/dev/repo', 'linux'),
    )
    expect(workspaceComparisonKey(fileUri('/home/dev/repo'), 'linux')).not.toBe(
      workspaceComparisonKey(fileUri('/home/DEV/repo'), 'linux'),
    )
  })

  it('compares remote paths case-sensitively and keeps authorities apart', () => {
    const key = workspaceComparisonKey(remoteUri('acme-host', '/home/dev/repo'), 'win32')
    expect(key).toBe('remote-ssh://acme-host/home/dev/repo')
    // Windows' case folding must not leak into the remote host's path identity.
    expect(workspaceComparisonKey(remoteUri('acme-host', '/home/DEV/repo'), 'win32')).not.toBe(key)
    // Same path, different host: separate workspaces.
    expect(workspaceComparisonKey(remoteUri('other-host', '/home/dev/repo'), 'win32')).not.toBe(key)
  })

  it('normalizes the remote authority spelling without touching the path', () => {
    expect(workspaceComparisonKey(remoteUri('wsl+Ubuntu', '/Repo'), 'linux')).toBe(
      workspaceComparisonKey(remoteUri('wsl+ubuntu', '/Repo'), 'linux'),
    )
    expect(workspaceComparisonKey(remoteUri('wsl+Ubuntu', '/Repo'), 'linux')).not.toBe(
      workspaceComparisonKey(remoteUri('wsl+ubuntu', '/repo'), 'linux'),
    )
  })

  it('rebuilds a composite key idempotently', () => {
    for (const workspace of [fileUri('X:/workspace/one'), remoteUri('acme-host', '/work/one')]) {
      const key = triggerKeyFor(workspace, 'weekly', 'win32')
      expect(canonicalTriggerKey(key)).toBe(key)
      expect(canonicalTriggerKey(`${workspace}/./\u0000weekly`)).toBe(key)
    }
  })

  it('rejects malformed keys and scopes membership by workspace', () => {
    expect(parseTriggerKey('weekly')).toBeUndefined()
    expect(parseTriggerKey('\u0000weekly')).toBeUndefined()
    expect(parseTriggerKey(`${getPathComparisonKey('X:/w', 'win32')}\u0000`)).toBeUndefined()

    const workspaceKey = workspaceComparisonKey(fileUri('X:/workspace/one'), 'win32')
    expect(
      triggerKeyBelongsToWorkspace(
        triggerKeyFor(fileUri('X:/Workspace/One'), 'a', 'win32'),
        workspaceKey,
      ),
    ).toBe(true)
    expect(
      triggerKeyBelongsToWorkspace(
        triggerKeyFor(fileUri('X:/workspace/two'), 'a', 'win32'),
        workspaceKey,
      ),
    ).toBe(false)
  })
})
