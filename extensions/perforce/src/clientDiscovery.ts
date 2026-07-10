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
 * v1 discovers a single client per open folder (the one `p4 info` resolves). The
 * multi-client P4CONFIG scan noted in the design is a later refinement; the
 * shape here (returning a list) leaves room for it.
 */
import type { P4Connection, P4Service } from './p4Service.js'
import { parseZtag } from './p4Output.js'
import { norm } from './pathUtil.js'

export interface DiscoveredClient {
  readonly clientName: string
  readonly clientRoot: string
  readonly userName?: string
}

function field(
  record: Record<string, string | string[]> | undefined,
  key: string,
): string | undefined {
  const v = record?.[key]
  return typeof v === 'string' && v ? v : undefined
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
  const { result } = await p4.execTagged(['info'], { noConnection: true })
  if (result.exitCode !== 0) return undefined
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
    log?.(`[discover] ambient client=${clientName} root=${clientRoot} owns folder`)
    return {
      clientName,
      clientRoot,
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
  return {
    clientName: matched.clientName,
    clientRoot: matched.clientRoot,
    ...(userName !== undefined ? { userName } : {}),
  }
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
  const { result } = await p4.execTagged(args, { noConnection: true })
  if (result.exitCode !== 0) {
    log?.(`[discover] p4 ${args.join(' ')} failed (exit ${result.exitCode}); cannot scan clients`)
    return undefined
  }
  let best: { clientName: string; clientRoot: string } | undefined
  let bestLen = -1
  for (const rec of parseZtag(result.stdout)) {
    const name = field(rec, 'client')
    const root = field(rec, 'Root')
    if (!name || !root || root.toLowerCase() === 'null') continue
    if (!rootContains(root, folder)) continue
    const len = norm(root).length
    if (len > bestLen) {
      best = { clientName: name, clientRoot: root }
      bestLen = len
    }
  }
  if (best)
    log?.(`[discover] matched client=${best.clientName} root=${best.clientRoot} for ${folder}`)
  return best
}

/**
 * Whether `root` is `folder` or one of its ancestors. Case-insensitive because a
 * Perforce client spec's `Root:` frequently differs in case from the on-disk
 * path the workspace was opened with (Windows paths are case-insensitive, so
 * both reach the same directory) — a case-sensitive `startsWith` would wrongly
 * reject a folder that really is inside the client root. Separators/drive-letter
 * are normalized via `norm` first.
 */
export function rootContains(root: string, folder: string): boolean {
  const r = norm(root).toLowerCase()
  const f = norm(folder).toLowerCase()
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
