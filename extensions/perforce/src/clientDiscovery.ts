/**
 * Discover the active Perforce client (workspace) for a folder. Runs a
 * connection-less `p4 -ztag info`, which reports `clientName`, `clientRoot` and
 * `userName` from the ambient environment (P4PORT/P4USER/P4CLIENT from env,
 * `p4 set`, or a P4CONFIG file at/above the folder). The fallback config
 * (`perforce.port/user/client`) fills any gap.
 *
 * The connection port is deliberately NOT taken from `p4 info`: its
 * `serverAddress` is the server's own internal bind address (e.g. `p4:1666`
 * behind a P4P proxy), not the routable P4PORT the client dialed. p4 resolves the
 * real P4PORT from P4CONFIG/env by cwd, so we let it — see {@link connectionFor}.
 *
 * Every accepted root is cross-checked against the client spec's FIXED `Root`
 * ({@link fixedClientRoot}): `p4 info`'s `clientRoot` answers for the *current
 * directory*, so inside one of the client's AltRoots it reports that AltRoot,
 * while the daily scope file belongs to the fixed Root. An AltRoot — and any
 * spec that cannot be read, so the root stays unverified — is refused rather
 * than adopted (fail closed) — see {@link verifiedClientRoot}.
 *
 * v1 discovers a single client per open folder (the one `p4 info` resolves). The
 * multi-client P4CONFIG scan noted in the design is a later refinement; the
 * shape here (returning a list) leaves room for it.
 */
import type { P4Connection, P4Service } from './p4Service.js'
import { parseZtag } from './p4Output.js'
import { norm, scopeKey } from './pathUtil.js'

/**
 * Upper bound for the discovery probes (`p4 info` / `p4 clients`). They are
 * connection-less reads that should return in milliseconds; when the resolved
 * P4PORT points at an unreachable server the TCP connect hangs until the OS
 * times out (minutes), and because discovery runs inside `activate`, a hang here
 * wedges the extension host's whole `onStartupFinished` activation batch — every
 * later activation event (including `onLanguage:typescript`) queues behind it.
 * A short watchdog kill makes an unreachable server fail fast instead of hanging
 * the host. Mirrors swarmAuth's `CREDENTIAL_PROBE_TIMEOUT_MS`.
 */
export const DISCOVERY_PROBE_TIMEOUT_MS = 15_000

export interface DiscoveredClient {
  readonly clientName: string
  readonly clientRoot: string
  readonly userName?: string
}

/** One entry of `p4 clients -u <user>`, for the switch-workspace quick-pick. */
export interface P4ClientEntry {
  readonly clientName: string
  readonly clientRoot: string
  readonly description?: string
}

function field(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const v = record?.[key]
  return typeof v === 'string' && v ? v : undefined
}

/** Case-insensitive {@link field}: `p4 -ztag` capitalizes most keys but the exact
 *  casing varies by command/server (`client` vs `Client` vs `Root`). */
function fieldAnyCase(
  record: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const wanted = key.toLowerCase()
  for (const [k, v] of Object.entries(record ?? {})) {
    if (k.toLowerCase() === wanted && typeof v === 'string' && v) return v
  }
  return undefined
}

/**
 * Parse `p4 -ztag clients` records. Real-server shape (PROBE-FINDINGS §5):
 * only `client` is lowercase, the rest are capitalized (`Root` / `Update` /
 * `Access` / `Owner` / `Description` / … — unlike fstat's all-lowercase
 * camelCase). `-Mj` collapses to a single `{"data": …}` blob on these servers,
 * so callers must feed `-ztag` records (via execRecords / execTagged, never
 * execJson). Entries without a usable name or root (including a literal
 * `null` root) are dropped.
 */
export function parseClientsList(records: readonly Record<string, unknown>[]): P4ClientEntry[] {
  const out: P4ClientEntry[] = []
  for (const rec of records) {
    const clientName = field(rec, 'client')
    const clientRoot = field(rec, 'Root')
    if (!clientName || !clientRoot || clientRoot.toLowerCase() === 'null') continue
    const description = field(rec, 'Description')
    out.push({
      clientName,
      clientRoot,
      ...(description !== undefined ? { description } : {}),
    })
  }
  return out
}

/**
 * Resolve the active client via `p4 info`. Returns undefined when p4 reports no
 * client root (`clientRoot` unset or literally "null"), which means the folder
 * isn't inside a Perforce workspace — the caller then disables the provider.
 *
 * `folder` is the open workspace directory. `p4 info` reports the *ambient*
 * client (from P4CLIENT / `p4 set` / P4CONFIG), which can name a workspace whose
 * root lives elsewhere on disk — unrelated to what's actually open. We only
 * accept that client when its root contains (or equals) the open folder.
 *
 * When the ambient client's root does NOT contain the folder, we don't give up:
 * the user may simply have a different global P4CLIENT. We list the user's
 * clients (`p4 clients -u <user>`) and pick the one whose root contains the
 * folder with the longest matching prefix — so opening any client's tree lights
 * up the right provider without needing a per-folder `.p4config`.
 */
export async function discoverClient(
  p4: P4Service,
  folder: string,
  fallback: P4Connection,
  log?: (msg: string) => void,
): Promise<DiscoveredClient | undefined> {
  const { result } = await p4.execTagged(['info'], {
    noConnection: true,
    timeoutMs: DISCOVERY_PROBE_TIMEOUT_MS,
  })
  if (result.exitCode !== 0) {
    log?.(
      `[discover] p4 info failed (exit ${result.exitCode})${result.stderr.trim() ? `: ${result.stderr.trim()}` : ''}; provider disabled`,
    )
    return undefined
  }
  const record = parseZtag(result.stdout)[0]

  const clientName = field(record, 'clientName') ?? fallback.client
  const clientRoot = field(record, 'clientRoot')
  const userName = field(record, 'userName') ?? fallback.user

  // The ambient client already owns the folder — use it directly.
  if (
    clientName &&
    clientRoot &&
    clientRoot.toLowerCase() !== 'null' &&
    rootContains(clientRoot, folder)
  ) {
    const verified = await verifiedClientRoot(p4, clientName, clientRoot, log)
    if (verified === undefined) return undefined
    log?.(`[discover] ambient client=${clientName} root=${verified} owns folder`)
    return {
      clientName,
      clientRoot: verified,
      ...(userName !== undefined ? { userName } : {}),
    }
  }

  // Ambient client doesn't cover this folder. Fall back to scanning the user's
  // clients for one whose root contains it (longest prefix wins).
  log?.(
    `[discover] ambient client=${clientName} root=${clientRoot} does not own ${folder}; scanning user clients`,
  )
  const owner = userName ?? fallback.user
  const matched = await findClientForFolder(p4, folder, owner, log)
  if (!matched) {
    log?.(`[discover] no client root contains ${folder}; provider disabled`)
    return undefined
  }
  const verified = await verifiedClientRoot(p4, matched.clientName, matched.clientRoot, log)
  if (verified === undefined) return undefined
  return {
    clientName: matched.clientName,
    clientRoot: verified,
    ...(userName !== undefined ? { userName } : {}),
  }
}

/**
 * The client spec's **fixed** `Root`, read from `p4 client -o` — the authoritative
 * answer to "which directory owns this client's `.p4delta-scope`".
 *
 * Connection-less like the `p4 info` probe above: `-p` is never derived from a p4
 * report, so p4 resolves the real P4PORT from P4CONFIG/env by cwd. Only the
 * client is pinned (`-c <name>`), which is what makes the spec unambiguous.
 *
 * Undefined = could not be read (probe failed, or the spec carries no `Root`).
 */
async function fixedClientRoot(
  p4: P4Service,
  clientName: string,
  log?: (msg: string) => void,
): Promise<string | undefined> {
  const args = ['-c', clientName, 'client', '-o']
  const { result, records } = await p4.execTagged(args, {
    noConnection: true,
    timeoutMs: DISCOVERY_PROBE_TIMEOUT_MS,
  })
  if (result.exitCode !== 0) {
    log?.(
      `[discover] p4 ${args.join(' ')} failed (exit ${result.exitCode})${result.stderr.trim() ? `: ${result.stderr.trim()}` : ''}`,
    )
    return undefined
  }
  for (const spec of records) {
    const root = fieldAnyCase(spec, 'Root')
    if (root && root.toLowerCase() !== 'null') return root
  }
  return undefined
}

/**
 * Confirm a discovered root IS the client spec's fixed `Root` before the provider
 * adopts it.
 *
 * Why this exists: `p4 info`'s `clientRoot` answers for the *current directory*.
 * Inside one of the client's AltRoots it reports that AltRoot, which is a
 * different on-disk tree — so adopting it would put the whole provider (root
 * routing, `//client/<relative>` spelling, and above all the `.p4delta-scope`
 * lookup) on a tree whose scope file is not the client's. An AltRoot with no
 * scope file of its own would read as "no config at all", silently widening the
 * workspace to the whole tree — the one reading the daily-scope red line forbids.
 *
 * So an AltRoot the spec PROVES is refused, not reconciled: this provider is
 * one-root-per-client (`clientRoot` is the routing key), and an AltRoot layout
 * cannot be served without inventing a second root.
 *
 * A spec that cannot be read is refused too — FAIL CLOSED. "Unprovable" is not
 * "verified": an unreadable `p4 -c <name> client -o` (probe error, or a spec
 * carrying no `Root` / a literal `null`) means the reported root is unverified
 * and could be an AltRoot, so adopting it would be guessing at the client's
 * root. A wrong guess is exactly the bug this guard exists to prevent (a
 * missing scope file read as "no config"), so every unreadable shape takes the
 * provider down for this folder with a logged reason instead of stepping over
 * the check. {@link fixedClientRoot} returning nothing therefore disables the
 * provider, just like a proven AltRoot.
 */
async function verifiedClientRoot(
  p4: P4Service,
  clientName: string,
  reportedRoot: string,
  log?: (msg: string) => void,
): Promise<string | undefined> {
  const fixed = await fixedClientRoot(p4, clientName, log)
  if (fixed === undefined) {
    log?.(
      `[discover] client=${clientName}: could not read the client spec's fixed Root; ${reportedRoot} is unverified (an AltRoot cannot be ruled out) — provider disabled`,
    )
    return undefined
  }
  if (sameRoot(fixed, reportedRoot)) return reportedRoot
  log?.(
    `[discover] client=${clientName}: p4 info reports root=${reportedRoot} but the client spec's fixed Root is ${fixed} — the folder sits on an AltRoot; provider disabled`,
  )
  return undefined
}

/**
 * Whether two p4 root spellings name the same directory, using {@link scopeKey}
 * — the host-adaptive path identity ({@link norm} plus case folding only where
 * the filesystem is case-insensitive). A client spec's `Root:` routinely differs
 * in case from the path `p4 info` echoes, and both sides here come from p4
 * itself, so on Windows/macOS a case-only difference is one directory; on linux
 * it is two, and treating them as one would accept an AltRoot.
 */
function sameRoot(a: string, b: string): boolean {
  return scopeKey(a) === scopeKey(b)
}

/**
 * List the user's clients and return the one whose root contains `folder` with
 * the longest matching prefix. `p4 clients -u <user>` needs a server connection,
 * so a failure here (offline / not logged in) just yields no match — the caller
 * then disables the provider, same as before.
 */
async function findClientForFolder(
  p4: P4Service,
  folder: string,
  owner: string | undefined,
  log?: (msg: string) => void,
): Promise<{ clientName: string; clientRoot: string } | undefined> {
  const args = owner ? ['clients', '-u', owner] : ['clients']
  const { result, records } = await p4.execTagged(args, {
    noConnection: true,
    timeoutMs: DISCOVERY_PROBE_TIMEOUT_MS,
  })
  if (result.exitCode !== 0) {
    log?.(
      `[discover] p4 ${args.join(' ')} failed (exit ${result.exitCode})${result.stderr.trim() ? `: ${result.stderr.trim()}` : ''}; cannot scan clients`,
    )
    return undefined
  }
  let best: { clientName: string; clientRoot: string } | undefined
  let bestLen = -1
  for (const { clientName, clientRoot } of parseClientsList(records)) {
    if (!rootContains(clientRoot, folder)) continue
    const len = norm(clientRoot).length
    if (len > bestLen) {
      best = { clientName, clientRoot }
      bestLen = len
    }
  }
  if (best)
    log?.(`[discover] matched client=${best.clientName} root=${best.clientRoot} for ${folder}`)
  return best
}

/**
 * Whether `root` is `folder` or one of its ancestors, using {@link scopeKey} for
 * identity. Case folds only where the host filesystem is case-insensitive (see
 * {@link scopeKey}): a client spec's `Root:` frequently differs in case from the
 * on-disk path the workspace was opened with, and on Windows/macOS that names the
 * same directory — a case-sensitive `startsWith` would wrongly reject a folder
 * that really is inside the client root. On linux the two are distinct paths and
 * must not match. Separators/drive-letter are normalized by the key first
 * ({@link scopeKey} builds on `norm`).
 */
export function rootContains(root: string, folder: string): boolean {
  const r = scopeKey(root)
  const f = scopeKey(folder)
  return f === r || f.startsWith(`${r}/`)
}

/**
 * Build the connection for subsequent commands. The client name is pinned
 * (`-c`) so the scan-fallback case — where the folder belongs to a client other
 * than the ambient one — targets the right workspace instead of letting the
 * cwd's P4CONFIG resolve back to the ambient client. User (`-u`) is passed when
 * known. Port (`-p`) is passed ONLY when the user set `perforce.port` explicitly:
 * otherwise it's omitted so p4 resolves the real P4PORT from P4CONFIG/env by cwd
 * (p4 info's serverAddress is the server's internal bind address, not routable).
 */
export function connectionFor(client: DiscoveredClient, fallback: P4Connection): P4Connection {
  return {
    ...(fallback.port ? { port: fallback.port } : {}),
    ...((client.userName ?? fallback.user) ? { user: client.userName ?? fallback.user } : {}),
    client: client.clientName,
  }
}
