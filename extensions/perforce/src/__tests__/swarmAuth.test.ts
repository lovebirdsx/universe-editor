import { describe, it, expect, vi } from 'vitest'
import {
  buildBasicAuth,
  pickTicketForUser,
  resolveTicket,
  resolveSwarmCredential,
} from '../swarm/swarmAuth.js'
import type { P4Service } from '../p4Service.js'

/**
 * A fake p4 that answers `login -s` (session check) and `tickets` (print the
 * cached ticket file) separately. `sessionOk` gates the `-s` call;
 * `ticketsStdout`/`ticketsExit` drive the `tickets` call. Records every argv so
 * tests can assert we NEVER run `login -p` (which would re-authenticate).
 */
function fakeP4(opts: { sessionOk?: boolean; ticketsStdout?: string; ticketsExit?: number }): {
  p4: P4Service
  calls: string[][]
} {
  const calls: string[][] = []
  const exec = vi.fn((args: readonly string[]) => {
    calls.push([...args])
    if (args[0] === 'login' && args.includes('-s')) {
      return Promise.resolve({ stdout: '', stderr: '', exitCode: opts.sessionOk ? 0 : 1 })
    }
    if (args[0] === 'tickets') {
      return Promise.resolve({
        stdout: opts.ticketsStdout ?? '',
        stderr: '',
        exitCode: opts.ticketsExit ?? 0,
      })
    }
    return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 })
  })
  return { p4: { exec } as unknown as P4Service, calls }
}

describe('swarmAuth.buildBasicAuth', () => {
  it('builds a Basic header from user:secret', () => {
    // base64('alice:ticket123') = YWxpY2U6dGlja2V0MTIz
    expect(buildBasicAuth('alice', 'ticket123')).toBe('Basic YWxpY2U6dGlja2V0MTIz')
  })

  it('handles non-ascii safely via utf8', () => {
    const header = buildBasicAuth('用户', 'pw')
    expect(header.startsWith('Basic ')).toBe(true)
    const decoded = Buffer.from(header.slice('Basic '.length), 'base64').toString('utf8')
    expect(decoded).toBe('用户:pw')
  })
})

describe('swarmAuth.pickTicketForUser', () => {
  const sample = ['server1:1666 (alice) AAAA1111', 'server2:1666 (bob) BBBB2222'].join('\n')

  it('picks the ticket for the matching user', () => {
    expect(pickTicketForUser(sample, 'bob')).toBe('BBBB2222')
  })

  it('matches the user case-insensitively (p4 usernames are)', () => {
    expect(pickTicketForUser(sample, 'ALICE')).toBe('AAAA1111')
  })

  it('returns the last match when several lines share the user', () => {
    const dup = 'p:1 (alice) OLD0000\np:2 (alice) NEW1111'
    expect(pickTicketForUser(dup, 'alice')).toBe('NEW1111')
  })

  it('returns undefined when no line matches', () => {
    expect(pickTicketForUser(sample, 'carol')).toBeUndefined()
  })

  it('returns undefined on empty output', () => {
    expect(pickTicketForUser('\n  \n', 'alice')).toBeUndefined()
  })
})

describe('swarmAuth.resolveTicket', () => {
  it('reads the cached ticket for the user via `p4 tickets`', async () => {
    const { p4, calls } = fakeP4({ sessionOk: true, ticketsStdout: 'srv:1666 (alice) TICKET42\n' })
    expect(await resolveTicket(p4, 'alice')).toBe('TICKET42')
    // Never re-authenticate.
    expect(calls.some((c) => c.includes('-p'))).toBe(false)
  })

  it('returns undefined without a live session, never running `tickets`', async () => {
    const { p4, calls } = fakeP4({ sessionOk: false })
    expect(await resolveTicket(p4, 'alice')).toBeUndefined()
    expect(calls.some((c) => c[0] === 'tickets')).toBe(false)
  })

  it('returns undefined when `p4 tickets` fails', async () => {
    const { p4 } = fakeP4({ sessionOk: true, ticketsExit: 1 })
    expect(await resolveTicket(p4, 'alice')).toBeUndefined()
  })

  it('returns undefined when no ticket matches the user', async () => {
    const { p4 } = fakeP4({ sessionOk: true, ticketsStdout: 'srv:1666 (bob) TICKET42\n' })
    expect(await resolveTicket(p4, 'alice')).toBeUndefined()
  })
})

describe('swarmAuth.resolveSwarmCredential', () => {
  it('returns undefined without a user', async () => {
    const { p4 } = fakeP4({ sessionOk: true, ticketsStdout: 'srv:1666 (alice) TICKET' })
    expect(await resolveSwarmCredential(p4, undefined)).toBeUndefined()
  })

  it('assembles a credential from user + cached ticket', async () => {
    const { p4 } = fakeP4({ sessionOk: true, ticketsStdout: 'srv:1666 (alice) TICKET\n' })
    const cred = await resolveSwarmCredential(p4, 'alice')
    expect(cred).toEqual({ user: 'alice', basic: buildBasicAuth('alice', 'TICKET') })
  })

  it('returns undefined when not logged in', async () => {
    const { p4 } = fakeP4({ sessionOk: false })
    expect(await resolveSwarmCredential(p4, 'alice')).toBeUndefined()
  })
})
