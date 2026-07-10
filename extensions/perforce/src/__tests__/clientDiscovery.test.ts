import { describe, expect, it } from 'vitest'
import { discoverClient, rootContains, connectionFor } from '../clientDiscovery.js'
import type { P4Service } from '../p4Service.js'

/**
 * Minimal P4Service stand-in. Discovery issues `p4 info` first and, when the
 * ambient client doesn't own the folder, `p4 clients -u <user>`. Route by the
 * first arg so a test can supply both fixtures (or fail one command).
 */
function fakeP4(routes: {
  info?: { stdout: string; exitCode?: number }
  clients?: { stdout: string; exitCode?: number }
}): P4Service {
  return {
    execTagged: async (args: readonly string[]) => {
      const cmd = args[0]
      const r = cmd === 'clients' ? routes.clients : routes.info
      const stdout = r?.stdout ?? ''
      const exitCode = r?.exitCode ?? (r ? 0 : 1)
      return { result: { stdout, stderr: '', exitCode }, records: [] }
    },
  } as unknown as P4Service
}

/** A `p4 -ztag info` block for a client rooted at `root`. */
function infoZtag(clientName: string, clientRoot: string): string {
  return [
    `... clientName ${clientName}`,
    `... clientRoot ${clientRoot}`,
    `... userName alice`,
    // serverAddress is the server's internal bind address; discovery must ignore
    // it for the connection port (that comes from P4CONFIG by cwd).
    `... serverAddress p4:1666`,
  ].join('\n')
}

/** A `p4 -ztag clients` block: one `... client` / `... Root` record per entry. */
function clientsZtag(entries: { name: string; root: string }[]): string {
  return entries
    .map((e) => [`... client ${e.name}`, `... Owner alice`, `... Root ${e.root}`].join('\n'))
    .join('\n\n')
}

describe('discoverClient', () => {
  it('accepts the ambient client when its root contains the open folder', async () => {
    const p4 = fakeP4({ info: { stdout: infoZtag('AkiBase', 'D:/depot/aki') } })
    const client = await discoverClient(p4, 'D:/depot/aki/game', {})
    expect(client?.clientName).toBe('AkiBase')
    expect(client?.clientRoot).toBe('D:/depot/aki')
  })

  it('accepts a deep folder when the client root differs only in case', async () => {
    // Regression: p4's `Root:` casing often differs from the on-disk path the
    // workspace opened with (Windows is case-insensitive). `G:\aki_3.6` root vs
    // an opened `G:/Aki_3.6/Source/Client/TypeScript` must still match.
    const p4 = fakeP4({ info: { stdout: infoZtag('AkiBase', 'G:\\aki_3.6') } })
    const client = await discoverClient(p4, 'G:/Aki_3.6/Source/Client/TypeScript', {})
    expect(client?.clientName).toBe('AkiBase')
  })

  it('accepts the client when its root equals the open folder', async () => {
    const p4 = fakeP4({ info: { stdout: infoZtag('AkiBase', 'D:/depot/aki') } })
    const client = await discoverClient(p4, 'D:/depot/aki', {})
    expect(client?.clientName).toBe('AkiBase')
  })

  it('falls back to a user client whose root contains the folder', async () => {
    // Real-world case: global P4CLIENT roots at D:\AkiBase, but the open folder
    // lives under a *different* client's root (G:\aki_3.6). Discovery must scan
    // the user's clients and pick the one that actually owns the folder.
    const p4 = fakeP4({
      info: { stdout: infoZtag('songxiao_aki_base', 'D:\\AkiBase') },
      clients: {
        stdout: clientsZtag([
          { name: 'songxiao_aki_base', root: 'D:\\AkiBase' },
          { name: 'songxiao_aki_branch_3.6', root: 'G:\\aki_3.6' },
        ]),
      },
    })
    const client = await discoverClient(p4, 'G:/aki_3.6/Source/Client/TypeScript', {})
    expect(client?.clientName).toBe('songxiao_aki_branch_3.6')
    expect(client?.clientRoot).toBe('G:\\aki_3.6')
  })

  it('picks the longest-prefix client when several roots contain the folder', async () => {
    const p4 = fakeP4({
      info: { stdout: infoZtag('other', 'D:\\elsewhere') },
      clients: {
        stdout: clientsZtag([
          { name: 'broad', root: 'G:\\aki_3.6' },
          { name: 'narrow', root: 'G:\\aki_3.6\\Source\\Client' },
        ]),
      },
    })
    const client = await discoverClient(p4, 'G:/aki_3.6/Source/Client/TypeScript', {})
    expect(client?.clientName).toBe('narrow')
  })

  it('returns undefined when no user client contains the folder', async () => {
    const p4 = fakeP4({
      info: { stdout: infoZtag('AkiBase', 'D:/depot/aki') },
      clients: { stdout: clientsZtag([{ name: 'AkiBase', root: 'D:/depot/aki' }]) },
    })
    const client = await discoverClient(p4, 'D:/git/universe-editor', {})
    expect(client).toBeUndefined()
  })

  it('returns undefined when the client scan fails (offline / not logged in)', async () => {
    const p4 = fakeP4({
      info: { stdout: infoZtag('AkiBase', 'D:/depot/aki') },
      clients: { stdout: '', exitCode: 1 },
    })
    const client = await discoverClient(p4, 'D:/git/universe-editor', {})
    expect(client).toBeUndefined()
  })

  it('scans clients when the ambient clientRoot is unset ("null")', async () => {
    const p4 = fakeP4({
      info: { stdout: infoZtag('AkiBase', 'null') },
      clients: { stdout: clientsZtag([{ name: 'branch', root: 'G:\\aki_3.6' }]) },
    })
    const client = await discoverClient(p4, 'G:/aki_3.6/Source', {})
    expect(client?.clientName).toBe('branch')
  })

  it('rejects on a non-zero p4 info exit', async () => {
    const p4 = fakeP4({ info: { stdout: '', exitCode: 1 } })
    const client = await discoverClient(p4, 'D:/depot/aki', {})
    expect(client).toBeUndefined()
  })
})

describe('rootContains', () => {
  it('matches equal paths ignoring separators and drive case', () => {
    expect(rootContains('D:\\depot\\aki', 'd:/depot/aki')).toBe(true)
  })

  it('matches an ancestor root', () => {
    expect(rootContains('D:/depot', 'D:/depot/aki/game')).toBe(true)
  })

  it('does not match a sibling path with a shared prefix', () => {
    expect(rootContains('D:/depot/aki', 'D:/depot/aki-extra')).toBe(false)
  })

  it('does not match an unrelated path', () => {
    expect(rootContains('D:/depot/aki', 'D:/git/universe-editor')).toBe(false)
  })
})

describe('connectionFor', () => {
  it('pins the client and user but omits the port so p4 resolves P4CONFIG by cwd', () => {
    const conn = connectionFor({ clientName: 'branch', clientRoot: 'G:\\aki', userName: 'bob' }, {})
    expect(conn).toEqual({ client: 'branch', user: 'bob' })
    expect(conn.port).toBeUndefined()
  })

  it('passes the port only when perforce.port is set explicitly', () => {
    const conn = connectionFor(
      { clientName: 'branch', clientRoot: 'G:\\aki', userName: 'bob' },
      { port: 'ssl:host:1666' },
    )
    expect(conn).toEqual({ client: 'branch', user: 'bob', port: 'ssl:host:1666' })
  })

  it('falls back to the config user when discovery reports none', () => {
    const conn = connectionFor({ clientName: 'branch', clientRoot: 'G:\\aki' }, { user: 'carol' })
    expect(conn).toEqual({ client: 'branch', user: 'carol' })
  })
})
