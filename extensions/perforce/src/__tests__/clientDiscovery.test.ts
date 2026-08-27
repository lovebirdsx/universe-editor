import { describe, expect, it } from 'vitest'
import {
  discoverClient,
  rootContains,
  connectionFor,
  DISCOVERY_PROBE_TIMEOUT_MS,
} from '../clientDiscovery.js'
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
    const p4 = fakeP4({ info: { stdout: infoZtag('DepotBase', 'D:/p4ws/main') } })
    const client = await discoverClient(p4, 'D:/p4ws/main/game', {})
    expect(client?.clientName).toBe('DepotBase')
    expect(client?.clientRoot).toBe('D:/p4ws/main')
  })

  it('accepts a deep folder when the client root differs only in case', async () => {
    // Regression: p4's `Root:` casing often differs from the on-disk path the
    // workspace opened with (Windows is case-insensitive). `G:\p4ws\main` root vs
    // an opened `G:/P4ws/main/src/client/scripts` must still match.
    const p4 = fakeP4({ info: { stdout: infoZtag('DepotBase', 'G:\\p4ws\\main') } })
    const client = await discoverClient(p4, 'G:/P4ws/main/src/client/scripts', {})
    expect(client?.clientName).toBe('DepotBase')
  })

  it('accepts the client when its root equals the open folder', async () => {
    const p4 = fakeP4({ info: { stdout: infoZtag('DepotBase', 'D:/p4ws/main') } })
    const client = await discoverClient(p4, 'D:/p4ws/main', {})
    expect(client?.clientName).toBe('DepotBase')
  })

  it('falls back to a user client whose root contains the folder', async () => {
    // Real-world case: global P4CLIENT roots at D:\p4ws\main, but the open folder
    // lives under a *different* client's root (G:\p4ws\main). Discovery must scan
    // the user's clients and pick the one that actually owns the folder.
    const p4 = fakeP4({
      info: { stdout: infoZtag('devuser_depot_main', 'D:\\p4ws\\main') },
      clients: {
        stdout: clientsZtag([
          { name: 'devuser_depot_main', root: 'D:\\p4ws\\main' },
          { name: 'devuser_depot_branch_a', root: 'G:\\p4ws\\main' },
        ]),
      },
    })
    const client = await discoverClient(p4, 'G:/p4ws/main/src/client/scripts', {})
    expect(client?.clientName).toBe('devuser_depot_branch_a')
    expect(client?.clientRoot).toBe('G:\\p4ws\\main')
  })

  it('picks the longest-prefix client when several roots contain the folder', async () => {
    const p4 = fakeP4({
      info: { stdout: infoZtag('other', 'D:\\elsewhere') },
      clients: {
        stdout: clientsZtag([
          { name: 'broad', root: 'G:\\p4ws\\main' },
          { name: 'narrow', root: 'G:\\p4ws\\main\\src\\client' },
        ]),
      },
    })
    const client = await discoverClient(p4, 'G:/p4ws/main/src/client/scripts', {})
    expect(client?.clientName).toBe('narrow')
  })

  it('returns undefined when no user client contains the folder', async () => {
    const p4 = fakeP4({
      info: { stdout: infoZtag('DepotBase', 'D:/p4ws/main') },
      clients: { stdout: clientsZtag([{ name: 'DepotBase', root: 'D:/p4ws/main' }]) },
    })
    const client = await discoverClient(p4, 'D:/git/universe-editor', {})
    expect(client).toBeUndefined()
  })

  it('returns undefined when the client scan fails (offline / not logged in)', async () => {
    const p4 = fakeP4({
      info: { stdout: infoZtag('DepotBase', 'D:/p4ws/main') },
      clients: { stdout: '', exitCode: 1 },
    })
    const client = await discoverClient(p4, 'D:/git/universe-editor', {})
    expect(client).toBeUndefined()
  })

  it('scans clients when the ambient clientRoot is unset ("null")', async () => {
    const p4 = fakeP4({
      info: { stdout: infoZtag('DepotBase', 'null') },
      clients: { stdout: clientsZtag([{ name: 'branch', root: 'G:\\p4ws\\main' }]) },
    })
    const client = await discoverClient(p4, 'G:/p4ws/main/src', {})
    expect(client?.clientName).toBe('branch')
  })

  it('rejects on a non-zero p4 info exit', async () => {
    const p4 = fakeP4({ info: { stdout: '', exitCode: 1 } })
    const client = await discoverClient(p4, 'D:/p4ws/main', {})
    expect(client).toBeUndefined()
  })

  it('bounds the info probe with a short timeout so an unreachable server fails fast', async () => {
    // Regression: `p4 info` on a P4PORT that never answers (firewall-drop / dead
    // gateway) hangs until the OS TCP timeout, and discovery runs inside the
    // extension's `activate` — a hang wedges the host's whole activation batch.
    // The probe must carry a watchdog timeout so it fails instead of hanging.
    const seen: number[] = []
    const p4 = {
      execTagged: async (_args: readonly string[], options?: { timeoutMs?: number }) => {
        seen.push(options?.timeoutMs ?? -1)
        return { result: { stdout: '', stderr: '', exitCode: 1 }, records: [] }
      },
    } as unknown as P4Service
    await discoverClient(p4, 'D:/p4ws/main', {})
    expect(seen).toEqual([DISCOVERY_PROBE_TIMEOUT_MS])
  })

  it('bounds the client-scan probe with the same short timeout', async () => {
    const seen: number[] = []
    const p4 = {
      execTagged: async (args: readonly string[], options?: { timeoutMs?: number }) => {
        seen.push(options?.timeoutMs ?? -1)
        if (args[0] === 'info') {
          return {
            result: { stdout: infoZtag('DepotBase', 'D:/p4ws/main'), exitCode: 0 },
            records: [],
          }
        }
        return {
          result: {
            stdout: clientsZtag([{ name: 'branch', root: 'G:\\p4ws\\main' }]),
            exitCode: 0,
          },
          records: [],
        }
      },
    } as unknown as P4Service
    await discoverClient(p4, 'G:/p4ws/main/src', {})
    expect(seen).toEqual([DISCOVERY_PROBE_TIMEOUT_MS, DISCOVERY_PROBE_TIMEOUT_MS])
  })
})

describe('rootContains', () => {
  it('matches equal paths ignoring separators and drive case', () => {
    expect(rootContains('D:\\p4ws\\main', 'd:/p4ws/main')).toBe(true)
  })

  it('matches an ancestor root', () => {
    expect(rootContains('D:/p4ws', 'D:/p4ws/main/game')).toBe(true)
  })

  it('does not match a sibling path with a shared prefix', () => {
    expect(rootContains('D:/p4ws/main', 'D:/p4ws/main-extra')).toBe(false)
  })

  it('does not match an unrelated path', () => {
    expect(rootContains('D:/p4ws/main', 'D:/git/universe-editor')).toBe(false)
  })
})

describe('connectionFor', () => {
  it('pins the client and user but omits the port so p4 resolves P4CONFIG by cwd', () => {
    const conn = connectionFor(
      { clientName: 'branch', clientRoot: 'G:\\depot', userName: 'bob' },
      {},
    )
    expect(conn).toEqual({ client: 'branch', user: 'bob' })
    expect(conn.port).toBeUndefined()
  })

  it('passes the port only when perforce.port is set explicitly', () => {
    const conn = connectionFor(
      { clientName: 'branch', clientRoot: 'G:\\depot', userName: 'bob' },
      { port: 'ssl:host:1666' },
    )
    expect(conn).toEqual({ client: 'branch', user: 'bob', port: 'ssl:host:1666' })
  })

  it('falls back to the config user when discovery reports none', () => {
    const conn = connectionFor({ clientName: 'branch', clientRoot: 'G:\\depot' }, { user: 'carol' })
    expect(conn).toEqual({ client: 'branch', user: 'carol' })
  })
})
