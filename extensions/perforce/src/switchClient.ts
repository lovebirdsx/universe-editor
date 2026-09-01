/**
 * Workspace (client) switching: list the user's p4 clients, let them pick one,
 * and wire the freshly created client into the manager with the same sequence
 * `activate()` applies to the first client. The old client stays alive
 * (multiple providers coexist, VSCode semantics) — `mgr.add` dedupes by root,
 * and the picked client becomes the active one.
 *
 * `wireSwitchedClient` is the wiring sequence as an injectable-step function so
 * a test can assert every step is taken in order — a missed step here shows up
 * as "switched, but the scopes are the old client's" and is otherwise invisible.
 */
import { window, type QuickPickItem } from '@universe-editor/extension-api'
import type { PerforceClient } from './client.js'
import type { ClientManager } from './clientManager.js'
import type { P4ClientEntry } from './clientDiscovery.js'
import { localize } from './nls.js'

/** The wiring steps a freshly created client needs, in the order `activate()`
 *  applies them to the first client. Each step is injectable so the sequence
 *  is unit-testable without the extension host. */
export interface SwitchClientWiring {
  add(client: PerforceClient): void
  setActive(root: string): void
  statusBarRefresh(): void
  trackClient(client: PerforceClient): void
  applyScopes(client: PerforceClient): Promise<void>
  applySyncPreviewOptions(client: PerforceClient): Promise<void>
  applyOpenedByOthersOptions(client: PerforceClient): Promise<void>
  startPolling(client: PerforceClient, seconds: number): void
  setSwarmAvailable(client: PerforceClient, available: boolean): void
}

/** Config values a freshly wired client inherits from the workspace. */
export interface SwitchedClientConfig {
  readonly refreshIntervalSec: number
  readonly swarmAvailable: boolean
}

/**
 * Wire a freshly created client into the manager, mirroring activate's
 * first-client sequence. Order matters: the background-check options (behind /
 * opened-by-others) are set BEFORE the first refresh so the checks the refresh
 * tail schedules don't silently skip on defaulted options.
 */
export async function wireSwitchedClient(
  client: PerforceClient,
  cfg: SwitchedClientConfig,
  wiring: SwitchClientWiring,
): Promise<void> {
  wiring.add(client)
  wiring.setActive(client.root)
  wiring.statusBarRefresh()
  wiring.trackClient(client)
  await wiring.applyScopes(client)
  await wiring.applySyncPreviewOptions(client)
  await wiring.applyOpenedByOthersOptions(client)
  void client.refresh()
  wiring.startPolling(client, cfg.refreshIntervalSec)
  wiring.setSwarmAvailable(client, cfg.swarmAvailable)
  void client.refresh()
}

export interface SwitchClientDeps {
  readonly mgr: ClientManager
  readonly log?: (msg: string) => void
  /** Build a PerforceClient for the picked entry (production wires
   *  `PerforceClient.createForClient`). */
  readonly createClient: (entry: P4ClientEntry) => PerforceClient
  /** Wire the freshly created client in (see {@link wireSwitchedClient}). */
  readonly wire: (client: PerforceClient) => Promise<void>
}

/** Build the quick-pick items: name + root (the root is what tells the user
 *  which branch a client maps), with the current client check-marked. Pure so
 *  the pick shape is testable. */
export function clientPicks(
  entries: readonly P4ClientEntry[],
  currentName: string,
): QuickPickItem[] {
  return entries.map((c) => ({
    label: c.clientName,
    description: c.clientRoot,
    ...(c.description !== undefined ? { detail: c.description } : {}),
    ...(c.clientName === currentName ? { iconId: 'check' } : {}),
  }))
}

/** The `perforce.switchClient` command flow. */
export async function switchClient(deps: SwitchClientDeps): Promise<void> {
  const current = deps.mgr.active
  if (!current) return
  const entries = await current.listUserClients()
  if (entries.length === 0) {
    await window.showErrorMessage(
      localize(
        'perforce.switchClient.none',
        'Could not list Perforce clients. Check the connection and log in first.',
      ),
    )
    return
  }
  // The user's own client is virtually always in the list; prepend it when not
  // so the current workspace is always visible with its check mark.
  const listed = entries.some((c) => c.clientName === current.clientName)
    ? entries
    : [{ clientName: current.clientName, clientRoot: current.root }, ...entries]

  const choice = await window.showQuickPick(clientPicks(listed, current.clientName), {
    placeHolder: localize(
      'perforce.switchClient.placeholder',
      'Switch to a Perforce workspace (client)',
    ),
  })
  if (!choice) return
  if (choice.label === current.clientName) return
  const entry = listed.find((c) => c.clientName === choice.label)
  if (!entry) return
  const created = deps.createClient(entry)
  await deps.wire(created)
  deps.log?.(`[perforce] switched active client to ${entry.clientName} (root ${entry.clientRoot})`)
}
