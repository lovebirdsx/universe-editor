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
const runDir = '/userData/triggers/runs/run-1'

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
        identity,
      ),
    ).toBe('once')
  })

  it('only auto-approves edit; delete and move stay manual', () => {
    expect(
      decideAutomatedPermission(
        request('delete', [{ path: `${runDir}/tmp.txt` }]),
        runDir,
        identity,
      ),
    ).toBeUndefined()
    expect(
      decideAutomatedPermission(request('move', [{ path: `${runDir}/tmp.txt` }]), runDir, identity),
    ).toBeUndefined()
  })

  it('rejects when any target lies outside the run directory', () => {
    expect(
      decideAutomatedPermission(
        request('edit', [{ path: `${runDir}/result.json` }, { path: '/repo/src/a.ts' }]),
        runDir,
        identity,
      ),
    ).toBeUndefined()
  })

  it('rejects a parent-directory escape', () => {
    expect(
      decideAutomatedPermission(
        request('edit', [{ path: `${runDir}/../escape.txt` }]),
        runDir,
        identity,
      ),
    ).toBeUndefined()
  })

  it('rejects any path that still contains a ".." segment after normalizing', () => {
    expect(
      decideAutomatedPermission(
        request('edit', [{ path: `${runDir}/sub/../result.json` }]),
        runDir,
        identity,
      ),
    ).toBeUndefined()
  })

  it('rejects location-less writes and non-write kinds', () => {
    expect(decideAutomatedPermission(request('edit'), runDir, identity)).toBeUndefined()
    for (const kind of ['read', 'search', 'execute', 'fetch', 'switch_mode', 'delete', 'move']) {
      expect(
        decideAutomatedPermission(request(kind, [{ path: `${runDir}/a.txt` }]), runDir, identity),
      ).toBeUndefined()
    }
  })

  it('never selects allow_always, and requires an allow_once option', () => {
    const onlyAlways = request(
      'edit',
      [{ path: `${runDir}/a.txt` }],
      [{ optionId: 'always', name: 'Always', kind: 'allow_always' }],
    )
    expect(decideAutomatedPermission(onlyAlways, runDir, identity)).toBeUndefined()
  })

  it('never auto-approves without a run directory', () => {
    expect(
      decideAutomatedPermission(
        request('edit', [{ path: `${runDir}/a.txt` }]),
        undefined,
        identity,
      ),
    ).toBeUndefined()
  })
})

describe('visibleAutomatedPermissionOptions', () => {
  it('hides allow_always options', () => {
    const params = request('edit', [{ path: `${runDir}/a.txt` }])
    expect(visibleAutomatedPermissionOptions(params.options).map((o) => o.optionId)).toEqual([
      'once',
      'deny',
    ])
  })
})
