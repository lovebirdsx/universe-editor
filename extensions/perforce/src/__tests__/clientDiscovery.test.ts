import { describe, expect, it } from 'vitest'
import {
  discoverClient,
  rootContains,
  connectionFor,
  parseClientsList,
  DISCOVERY_PROBE_TIMEOUT_MS,
} from '../clientDiscovery.js'
import { parseZtag } from '../p4Output.js'
import type { P4Service } from '../p4Service.js'

/**
 * Minimal P4Service stand-in. Discovery issues `p4 info` first; when a root is a
 * candidate it then asks `p4 -c <name> client -o` for the spec's FIXED Root, and
 * when the ambient client doesn't own the folder it scans `p4 clients -u <user>`
 * in between. Route by the args so a test can supply a fixture for each.
 *
 * The spec fixture DEFAULTS to agreeing with the root the other fixtures report
 * for that client — a single-Root client's spec says exactly what `p4 info` says
 * — so a test supplies `spec` only when it wants an AltRoot layout (roots that
 * disagree) or an unreadable spec.
 */
function fakeP4(routes: {
  info?: { stdout: string; exitCode?: number }
  clients?: { stdout: string; exitCode?: number }
  spec?: { stdout: string; exitCode?: number }
}): P4Service {
  return {
    execTagged: async (args: readonly string[]) => {
      const isSpec = args.includes('client') && args.includes('-o')
      const clientName = isSpec ? args[args.indexOf('-c') + 1] : undefined
      const r = isSpec
        ? (routes.spec ?? { stdout: specZtag(reportedRootFor(routes, clientName)) })
        : args[0] === 'clients'
          ? routes.clients
          : routes.info
      const stdout = r?.stdout ?? ''
      const exitCode = r?.exitCode ?? (r ? 0 : 1)
      return { result: { stdout, stderr: '', exitCode }, records: parseZtag(stdout) }
    },
  } as unknown as P4Service
}

/** The root the non-spec fixtures report for `clientName` — what a single-Root
 *  client's spec would say. Empty (no `Root` field) when no fixture names it. */
function reportedRootFor(
  routes: { info?: { stdout: string }; clients?: { stdout: string } },
  clientName: string | undefined,
): string {
  for (const record of parseZtag(routes.info?.stdout ?? '')) {
    if (record['clientName'] === clientName && typeof record['clientRoot'] === 'string')
      return record['clientRoot'] as string
  }
  for (const record of parseZtag(routes.clients?.stdout ?? '')) {
    if (record['client'] === clientName && typeof record['Root'] === 'string')
      return record['Root'] as string
  }
  return ''
}

/** A `p4 -ztag client -o` block: the spec's fixed `Root` (capitalized key). */
function specZtag(root: string): string {
  return [
    '... Client DepotBase',
    '... Owner alice',
    ...(root ? [`... Root ${root}`] : []),
    '... Options noallwrite noclobber nocompress unlocked nomodtime normdir',
  ].join('\n')
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

  it('accepts a deep folder whose root differs only in case, on a case-insensitive host', async () => {
    // Regression: p4's `Root:` casing often differs from the on-disk path the
    // workspace opened with (Windows/macOS are case-insensitive). `G:\p4ws\main`
    // root vs an opened `G:/P4ws/main/src/client/scripts` must still match there.
    // The case policy follows the host (see `scopeKey`): on linux these are two
    // directories, so this is asserted per platform rather than unconditionally —
    // asserting the win32 answer everywhere is what passes locally and fails CI.
    const p4 = fakeP4({ info: { stdout: infoZtag('DepotBase', 'G:\\p4ws\\main') } })
    const client = await discoverClient(p4, 'G:/P4ws/main/src/client/scripts', {})
    if (process.platform === 'win32' || process.platform === 'darwin') {
      expect(client?.clientName).toBe('DepotBase')
    } else {
      expect(client).toBeUndefined()
    }
  })

  it('accepts the client when its root equals the open folder', async () => {
    const p4 = fakeP4({ info: { stdout: infoZtag('DepotBase', 'D:/p4ws/main') } })
    const client = await discoverClient(p4, 'D:/p4ws/main', {})
    expect(client?.clientName).toBe('DepotBase')
  })

  it('refuses a reported root that is an AltRoot, not the spec’s fixed Root', async () => {
    // `p4 info` answers for the *current directory*: from inside an AltRoot it
    // reports that AltRoot, while the client's fixed Root — and the
    // `.p4delta-scope` that belongs to it — is elsewhere. Adopting the AltRoot
    // would point root routing, the `//client/<relative>` spelling and the scope
    // lookup all at a tree whose scope file is not the client's (and whose
    // missing scope file would read as "no config at all").
    const p4 = fakeP4({
      info: { stdout: infoZtag('DepotBase', 'D:/alt/main') },
      spec: { stdout: specZtag('D:/p4ws/main') },
    })
    const client = await discoverClient(p4, 'D:/alt/main/src', {})
    expect(client).toBeUndefined()
  })

  it('refuses an AltRoot the client scan picked up too', async () => {
    // The scan reports `Root` normally, but the folder it matched can still sit
    // on an AltRoot of that client — the same check has to run on this path.
    const p4 = fakeP4({
      info: { stdout: infoZtag('other', 'D:\\elsewhere') },
      clients: { stdout: clientsZtag([{ name: 'DepotBase', root: 'D:/alt/main' }]) },
      spec: { stdout: specZtag('D:/p4ws/main') },
    })
    const client = await discoverClient(p4, 'D:/alt/main/src', {})
    expect(client).toBeUndefined()
  })

  it('accepts a spec Root that differs from the reported root only in case, on a case-insensitive host', async () => {
    // Case-only differences are the same directory on Windows/macOS and two
    // directories on linux (see `scopeKey`): there the spec's Root proves the
    // reported root is an AltRoot, so discovery refuses.
    const p4 = fakeP4({
      info: { stdout: infoZtag('DepotBase', 'd:/p4ws/main') },
      spec: { stdout: specZtag('D:\\P4ws\\Main') },
    })
    const client = await discoverClient(p4, 'd:/p4ws/main/src', {})
    if (process.platform === 'win32' || process.platform === 'darwin') {
      expect(client?.clientRoot).toBe('d:/p4ws/main')
    } else {
      expect(client).toBeUndefined()
    }
  })

  it('accepts a spec Root that differs only in separator and drive letter, on every host', async () => {
    // The half that does NOT follow the host case policy — `norm`'s drive-letter
    // fold and separator unification — so this holds on the linux CI too.
    const p4 = fakeP4({
      info: { stdout: infoZtag('DepotBase', 'd:/p4ws/main') },
      spec: { stdout: specZtag('D:\\p4ws\\main') },
    })
    const client = await discoverClient(p4, 'd:/p4ws/main/src', {})
    expect(client?.clientRoot).toBe('d:/p4ws/main')
  })

  it('fails closed — disables the provider — when the client spec cannot be read', async () => {
    // The AltRoot guard is the only thing keeping the provider off a tree whose
    // `.p4delta-scope` is not the client's. An unreadable `p4 client -o` leaves
    // the reported root UNPROVEN: adopting it guesses at the client's root, and a
    // wrong guess reads a missing scope file as "no config at all" (the one
    // reading the daily-scope red line forbids). Every unreadable shape — probe
    // error, no `Root` field, a literal `null` Root — disables the provider
    // rather than stepping over the check.
    const shapes = [
      { label: 'probe error', spec: { stdout: '', exitCode: 1 } },
      { label: 'no Root field', spec: { stdout: specZtag('') } },
      { label: 'literal null Root', spec: { stdout: specZtag('null') } },
    ]
    for (const { label, spec } of shapes) {
      const logs: string[] = []
      const p4 = fakeP4({ info: { stdout: infoZtag('DepotBase', 'D:/p4ws/main') }, spec })
      const client = await discoverClient(p4, 'D:/p4ws/main', {}, (msg) => logs.push(msg))
      expect(client, label).toBeUndefined()
      expect(
        logs.some((line) => line.includes('provider disabled')),
        label,
      ).toBe(true)
    }
  })

  it('pins the client on the spec probe and keeps the probe connection-less', async () => {
    // The port must stay p4's own resolution (P4CONFIG/env by cwd): pinning the
    // client is the one global option the spec read needs, and `noConnection`
    // is what keeps `perforce.port` out of it — a `-p` derived from a p4 report
    // would be a routable-port bug (see the module header).
    const probes: { args: readonly string[]; noConnection: boolean | undefined }[] = []
    const p4 = {
      execTagged: async (args: readonly string[], options?: { noConnection?: boolean }) => {
        if (args.includes('-o')) probes.push({ args, noConnection: options?.noConnection })
        const stdout = args.includes('-o')
          ? specZtag('D:/p4ws/main')
          : args[0] === 'info'
            ? infoZtag('DepotBase', 'D:/p4ws/main')
            : ''
        return { result: { stdout, stderr: '', exitCode: 0 }, records: parseZtag(stdout) }
      },
    } as unknown as P4Service
    const client = await discoverClient(p4, 'D:/p4ws/main', {})
    expect(client?.clientName).toBe('DepotBase')
    expect(probes).toEqual([{ args: ['-c', 'DepotBase', 'client', '-o'], noConnection: true }])
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

  it('bounds the client-scan and fixed-Root probes with the same short timeout', async () => {
    const seen: number[] = []
    const p4 = {
      execTagged: async (args: readonly string[], options?: { timeoutMs?: number }) => {
        seen.push(options?.timeoutMs ?? -1)
        const stdout =
          args[0] === 'info'
            ? infoZtag('DepotBase', 'D:/p4ws/main')
            : args.includes('-o')
              ? specZtag('G:\\p4ws\\main')
              : clientsZtag([{ name: 'branch', root: 'G:\\p4ws\\main' }])
        return { result: { stdout, stderr: '', exitCode: 0 }, records: parseZtag(stdout) }
      },
    } as unknown as P4Service
    await discoverClient(p4, 'G:/p4ws/main/src', {})
    // info → clients → the fixed-Root check of the matched client.
    expect(seen).toEqual([
      DISCOVERY_PROBE_TIMEOUT_MS,
      DISCOVERY_PROBE_TIMEOUT_MS,
      DISCOVERY_PROBE_TIMEOUT_MS,
    ])
  })
})

describe('rootContains', () => {
  it('matches equal paths ignoring separators and drive case', () => {
    expect(rootContains('D:\\p4ws\\main', 'd:/p4ws/main')).toBe(true)
  })

  it('treats a case-only difference as one directory only on a case-insensitive host', () => {
    // The case policy follows the host (`scopeKey`): `D:/P4ws/Main` names the
    // same tree as `D:/p4ws/main` on Windows/macOS but a different one on linux —
    // where `p4ws` and `P4ws` really are two directories under `/`.
    const insensitive = process.platform === 'win32' || process.platform === 'darwin'
    expect(rootContains('D:/P4ws/Main', 'd:/p4ws/main/src')).toBe(insensitive)
    expect(rootContains('D:/p4ws/main', 'D:/P4WS/Main')).toBe(insensitive)
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

describe('parseClientsList', () => {
  // PROBE-FINDINGS §5, verbatim field names from `p4 -ztag clients`: ONLY
  // `client` is lowercase, the rest are capitalized — unlike fstat's
  // all-lowercase camelCase. Parsers reading lowercase `root` would drop every
  // entry on a real server.
  const realZtagClient = [
    '... client testclient',
    '... Update 2026/08/11 10:00:00',
    '... Access 2026/08/11 10:00:00',
    '... Owner testuser',
    '... Options noallwrite noclobber nocompress unlocked nomodtime normdir',
    '... SubmitOptions submitunchanged',
    '... LineEnd local',
    '... Root X:\\p4ws\\main',
    '... Host DESKTOP-TEST',
    '... Stream //depot/branch_x',
    '... Type writeable',
    '... Description Created by testuser.',
  ].join('\n')

  it('parses the real -ztag shape with capitalized field names', () => {
    expect(parseClientsList(parseZtag(realZtagClient))).toEqual([
      {
        clientName: 'testclient',
        clientRoot: 'X:\\p4ws\\main',
        description: 'Created by testuser.',
      },
    ])
  })

  it('parses multiple clients in one output', () => {
    const ztag = [
      realZtagClient,
      [
        '... client otherclient',
        '... Update 2026/08/11 10:00:00',
        '... Owner testuser',
        '... Root X:\\p4ws\\branch_a',
        '... Description Branch workspace.',
      ].join('\n'),
    ].join('\n\n')
    expect(parseClientsList(parseZtag(ztag))).toEqual([
      {
        clientName: 'testclient',
        clientRoot: 'X:\\p4ws\\main',
        description: 'Created by testuser.',
      },
      {
        clientName: 'otherclient',
        clientRoot: 'X:\\p4ws\\branch_a',
        description: 'Branch workspace.',
      },
    ])
  })

  it('omits the description key when the record has none', () => {
    const ztag = ['... client testclient', '... Owner testuser', '... Root X:\\p4ws\\main'].join(
      '\n',
    )
    const [entry] = parseClientsList(parseZtag(ztag))
    expect(entry?.clientName).toBe('testclient')
    expect('description' in entry!).toBe(false)
  })

  it('drops records without a client name', () => {
    const ztag = ['... Owner testuser', '... Root X:\\p4ws\\main'].join('\n')
    expect(parseClientsList(parseZtag(ztag))).toEqual([])
  })

  it('drops records with a missing or literal "null" root', () => {
    const ztag = [
      ['... client testclient', '... Root null'].join('\n'),
      ['... client otherclient', '... Owner testuser'].join('\n'),
    ].join('\n\n')
    expect(parseClientsList(parseZtag(ztag))).toEqual([])
  })

  it('returns an empty list for empty output', () => {
    expect(parseClientsList([])).toEqual([])
    expect(parseClientsList(parseZtag(''))).toEqual([])
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
