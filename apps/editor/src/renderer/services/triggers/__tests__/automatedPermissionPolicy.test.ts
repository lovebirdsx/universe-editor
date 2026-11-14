/*---------------------------------------------------------------------------------------------
 *  Tests for the automated-session permission policy (design §4, renderer side).
 *--------------------------------------------------------------------------------------------*/

import type { RequestPermissionRequest } from '@agentclientprotocol/sdk'
import { UriIdentityService } from '@universe-editor/platform'
import { describe, expect, it } from 'vitest'
import {
  decideAutomatedPermission,
  visibleAutomatedPermissionOptions,
} from '../automatedPermissionPolicy.js'

const identity = new UriIdentityService('linux')
// A Windows client is where the old path-string comparison misjudged remote
// POSIX paths: its case folding must not apply to another host's filesystem.
const windowsIdentity = new UriIdentityService('win32')
const runDir = '/userData/triggers/runs/run-1'
const remoteAuthority = 'ssh-remote+host.example.com'
const remoteRunDir = '/home/user/.config/universe-editor/triggers/runs/run-1'

function request(
  kind: string | null,
  locations: readonly { path: string }[] = [],
  options: RequestPermissionRequest['options'] = [
    { optionId: 'once', name: 'Allow once', kind: 'allow_once' },
    { optionId: 'always', name: 'Always', kind: 'allow_always' },
    { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
  ],
): RequestPermissionRequest {
  return {
    sessionId: 'agent-1',
    toolCall: {
      toolCallId: 'tc-1',
      kind,
      title: 'tool',
      ...(locations.length > 0 ? { locations } : {}),
    },
    options,
  } as RequestPermissionRequest
}

describe('decideAutomatedPermission', () => {
  it('allows a one-shot write whose targets all lie under the run directory', () => {
    expect(
      decideAutomatedPermission(
        request('edit', [{ path: `${runDir}/result.json` }, { path: `${runDir}/report.md` }]),
        runDir,
        undefined,
        identity,
      ),
    ).toBe('once')
  })

  it('only auto-approves edit; delete and move stay manual', () => {
    expect(
      decideAutomatedPermission(
        request('delete', [{ path: `${runDir}/tmp.txt` }]),
        runDir,
        undefined,
        identity,
      ),
    ).toBeUndefined()
    expect(
      decideAutomatedPermission(
        request('move', [{ path: `${runDir}/tmp.txt` }]),
        runDir,
        undefined,
        identity,
      ),
    ).toBeUndefined()
  })

  it('rejects when any target lies outside the run directory', () => {
    expect(
      decideAutomatedPermission(
        request('edit', [{ path: `${runDir}/result.json` }, { path: '/repo/src/a.ts' }]),
        runDir,
        undefined,
        identity,
      ),
    ).toBeUndefined()
  })

  it('rejects a parent-directory escape', () => {
    expect(
      decideAutomatedPermission(
        request('edit', [{ path: `${runDir}/../escape.txt` }]),
        runDir,
        undefined,
        identity,
      ),
    ).toBeUndefined()
  })

  it('rejects any path that still contains a ".." segment after normalizing', () => {
    expect(
      decideAutomatedPermission(
        request('edit', [{ path: `${runDir}/sub/../result.json` }]),
        runDir,
        undefined,
        identity,
      ),
    ).toBeUndefined()
  })

  it('rejects location-less writes and non-write kinds', () => {
    expect(decideAutomatedPermission(request('edit'), runDir, undefined, identity)).toBeUndefined()
    for (const kind of ['read', 'search', 'execute', 'fetch', 'switch_mode', 'delete', 'move']) {
      expect(
        decideAutomatedPermission(
          request(kind, [{ path: `${runDir}/a.txt` }]),
          runDir,
          undefined,
          identity,
        ),
      ).toBeUndefined()
    }
  })

  it('never selects allow_always, and requires an allow_once option', () => {
    const onlyAlways = request(
      'edit',
      [{ path: `${runDir}/a.txt` }],
      [{ optionId: 'always', name: 'Always', kind: 'allow_always' }],
    )
    expect(decideAutomatedPermission(onlyAlways, runDir, undefined, identity)).toBeUndefined()
  })

  it('never auto-approves without a run directory', () => {
    expect(
      decideAutomatedPermission(
        request('edit', [{ path: `${runDir}/a.txt` }]),
        undefined,
        undefined,
        identity,
      ),
    ).toBeUndefined()
  })

  it('keeps local Windows paths case-insensitive', () => {
    expect(
      decideAutomatedPermission(
        request('edit', [{ path: 'c:\\USERDATA\\triggers\\RUNS\\run-1\\result.json' }]),
        'C:\\UserData\\triggers\\runs\\run-1',
        undefined,
        windowsIdentity,
      ),
    ).toBe('once')
  })

  it('treats remote paths case-sensitively even on a Windows client', () => {
    expect(
      decideAutomatedPermission(
        request('edit', [{ path: `${remoteRunDir}/result.json` }]),
        remoteRunDir,
        remoteAuthority,
        windowsIdentity,
      ),
    ).toBe('once')
    expect(
      decideAutomatedPermission(
        request('edit', [{ path: `${remoteRunDir.toUpperCase()}/result.json` }]),
        remoteRunDir,
        remoteAuthority,
        windowsIdentity,
      ),
    ).toBeUndefined()
  })

  it('rejects a remote target outside the remote run directory', () => {
    expect(
      decideAutomatedPermission(
        request('edit', [{ path: '/home/user/repo/src/a.ts' }]),
        remoteRunDir,
        remoteAuthority,
        windowsIdentity,
      ),
    ).toBeUndefined()
    // A local path string can never resolve onto a different host's run dir.
    expect(
      decideAutomatedPermission(
        request('edit', [{ path: `/home/user/repo/src/a.ts` }]),
        remoteRunDir,
        remoteAuthority,
        identity,
      ),
    ).toBeUndefined()
  })

  it('does not treat a differently-cased sibling prefix as inside the run dir', () => {
    expect(
      decideAutomatedPermission(
        request('edit', [{ path: `${remoteRunDir}-other/result.json` }]),
        remoteRunDir,
        remoteAuthority,
        windowsIdentity,
      ),
    ).toBeUndefined()
  })
})

describe('visibleAutomatedPermissionOptions', () => {
  it('hides allow_always so no durable personal rule can be persisted', () => {
    const options = [
      { optionId: 'once', name: 'Once', kind: 'allow_once' },
      { optionId: 'always', name: 'Always', kind: 'allow_always' },
      { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
    ]
    expect(visibleAutomatedPermissionOptions(options).map((option) => option.optionId)).toEqual([
      'once',
      'deny',
    ])
  })
})
