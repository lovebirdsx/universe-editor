import type { RequestPermissionRequest } from '@agentclientprotocol/sdk'
import { UriIdentityService } from '@universe-editor/platform'
import { describe, expect, it } from 'vitest'
import { decideInternalPermission } from '../acpSessionService.js'

const identity = new UriIdentityService('linux')
const cwd = '/repo/temp'

function request(
  kind: string | null,
  locations: readonly { path: string }[] = [],
): RequestPermissionRequest {
  return {
    sessionId: 'agent-1',
    toolCall: {
      toolCallId: 'tc-1',
      kind,
      title: 'tool',
      ...(locations.length > 0 ? { locations } : {}),
    },
    options: [
      { optionId: 'once', name: 'Allow', kind: 'allow_once' },
      { optionId: 'always', name: 'Always', kind: 'allow_always' },
      { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
    ],
  } as RequestPermissionRequest
}

describe('decideInternalPermission', () => {
  it('allows location-less reads in a read-only internal session', () => {
    expect(
      decideInternalPermission(request('read'), { internalWritable: false, cwd }, identity),
    ).toBe('once')
  })

  it('rejects edits in a read-only internal session even inside cwd', () => {
    expect(
      decideInternalPermission(
        request('edit', [{ path: '/repo/temp/a.ts' }]),
        { internalWritable: false, cwd },
        identity,
      ),
    ).toBeUndefined()
  })

  it('allows writes inside cwd in a writable internal session', () => {
    expect(
      decideInternalPermission(
        request('edit', [{ path: '/repo/temp/a.ts' }]),
        { internalWritable: true, cwd },
        identity,
      ),
    ).toBe('once')
  })

  it('rejects location-less writes in a writable internal session', () => {
    expect(
      decideInternalPermission(request('delete'), { internalWritable: true, cwd }, identity),
    ).toBeUndefined()
  })

  it('rejects writes outside cwd', () => {
    expect(
      decideInternalPermission(
        request('move', [{ path: '/repo/other/a.ts' }]),
        { internalWritable: true, cwd },
        identity,
      ),
    ).toBeUndefined()
  })

  it('rejects execute, fetch and switch_mode', () => {
    for (const kind of ['execute', 'fetch', 'switch_mode']) {
      expect(
        decideInternalPermission(
          request(kind, [{ path: '/repo/temp/a.ts' }]),
          { internalWritable: true, cwd },
          identity,
        ),
      ).toBeUndefined()
    }
  })

  it('never selects allow_always even when it is the only option', () => {
    const params = request('read')
    const onlyAlways = {
      ...params,
      options: [{ optionId: 'always', name: 'Always', kind: 'allow_always' }],
    } as RequestPermissionRequest
    expect(decideInternalPermission(onlyAlways, { internalWritable: true, cwd }, identity)).toBe(
      undefined,
    )
  })
})
