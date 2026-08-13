/*---------------------------------------------------------------------------------------------
 *  Tests for packages/platform/src/ipc/uriIpc.ts
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import { URI } from '../../base/uri.js'
import { createRemoteURITransformer } from '../../ipc/uriIpc.js'

describe('createRemoteURITransformer', () => {
  const t = createRemoteURITransformer('wsl')

  it('maps remote-ssh to file on incoming, clearing authority', () => {
    const out = t.transformIncoming({
      scheme: 'remote-ssh',
      authority: 'wsl',
      path: '/home/x',
      query: 'a=1',
    })
    expect(out).toEqual({ $mid: 1, scheme: 'file', path: '/home/x', query: 'a=1' })
  })

  it('maps file to remote-ssh on outgoing, stamping authority', () => {
    const out = t.transformOutgoing({ scheme: 'file', path: '/home/y', fragment: 'f' })
    expect(out).toEqual({
      $mid: 1,
      scheme: 'remote-ssh',
      authority: 'wsl',
      path: '/home/y',
      fragment: 'f',
    })
  })

  it('leaves non-remote-ssh schemes untouched on incoming', () => {
    const uri = { scheme: 'file', path: '/local' }
    expect(t.transformIncoming(uri)).toBe(uri)
  })

  it('leaves non-file schemes untouched on outgoing', () => {
    const uri = { scheme: 'https', authority: 'example.com', path: '/' }
    expect(t.transformOutgoing(uri)).toBe(uri)
  })

  it('round-trips a file uri through outgoing then incoming', () => {
    const out = t.transformOutgoing({ scheme: 'file', path: '/a' })
    const back = t.transformIncoming(out)
    expect(URI.revive(back)?.toString()).toBe('file:///a')
  })
})
