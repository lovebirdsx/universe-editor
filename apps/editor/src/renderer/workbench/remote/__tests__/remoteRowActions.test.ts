/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/renderer/workbench/remote/remoteRowActions.ts
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import { dotStateOf, remoteRowPrimaryAction } from '../remoteRowActions.js'

describe('dotStateOf', () => {
  it('maps connected states onto the four dot buckets', () => {
    expect(dotStateOf('connected')).toBe('connected')
    expect(dotStateOf('reconnecting')).toBe('connecting')
    expect(dotStateOf('deploying')).toBe('connecting')
    expect(dotStateOf('forwarding')).toBe('connecting')
    expect(dotStateOf('handshaking')).toBe('connecting')
    expect(dotStateOf('failed')).toBe('failed')
    expect(dotStateOf(undefined)).toBe('idle')
    expect(dotStateOf('idle')).toBe('idle')
    expect(dotStateOf('disposed')).toBe('idle')
  })
})

describe('remoteRowPrimaryAction', () => {
  it('opens a folder on the host when the connection is live', () => {
    expect(remoteRowPrimaryAction('connected')).toBe('remote.openFolder')
  })

  it('retries a failed connection', () => {
    expect(remoteRowPrimaryAction('failed')).toBe('remote.retryConnection')
  })

  it('connects for targets with no live connection (or an idle/disposed one)', () => {
    expect(remoteRowPrimaryAction(undefined)).toBe('remote.connectToHost')
    expect(remoteRowPrimaryAction('idle')).toBe('remote.connectToHost')
    expect(remoteRowPrimaryAction('disposed')).toBe('remote.connectToHost')
  })

  it('has no primary action for in-flight states', () => {
    expect(remoteRowPrimaryAction('reconnecting')).toBeNull()
    expect(remoteRowPrimaryAction('deploying')).toBeNull()
    expect(remoteRowPrimaryAction('forwarding')).toBeNull()
    expect(remoteRowPrimaryAction('handshaking')).toBeNull()
  })
})
