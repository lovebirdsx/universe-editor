/**
 * Owns the set of Perforce clients surfaced through the SCM API and routes a
 * command's argument to the right one. All p4 source controls share the id
 * `perforce`, so routing keys off each client's unique root: provider/group
 * commands carry `{ rootUri }`; resource/folder commands carry an absolute
 * `resourceUri`, matched to the client with the longest containing root.
 * Mirrors git's RepositoryManager.
 */
import type { PerforceClient } from './client.js'
import { norm } from './pathUtil.js'

interface ClientArg {
  readonly rootUri?: string
  readonly resourceUri?: string
}

export class ClientManager {
  private readonly _clients = new Map<string, PerforceClient>()
  /** The client argument-less commands target; mirrors the SCM view selection,
   *  pushed via `perforce.setActiveRepo`. Defaults to the first added. */
  private _activeRoot: string | undefined

  get active(): PerforceClient | undefined {
    if (this._activeRoot) {
      const hit = this._clients.get(norm(this._activeRoot))
      if (hit) return hit
    }
    return this._clients.values().next().value
  }

  /** Point argument-less commands at `root` when it names a known client. */
  setActive(root: string | undefined): void {
    if (root && this._clients.has(norm(root))) this._activeRoot = root
  }

  get all(): PerforceClient[] {
    return [...this._clients.values()]
  }

  add(client: PerforceClient): void {
    const key = norm(client.root)
    if (this._clients.has(key)) return
    this._clients.set(key, client)
    this._activeRoot ??= client.root
  }

  resolveClient(arg: unknown): PerforceClient | undefined {
    const a = (arg ?? undefined) as ClientArg | undefined
    if (a?.rootUri) {
      const hit = this._clients.get(norm(a.rootUri))
      if (hit) return hit
    }
    if (a?.resourceUri) {
      const hit = this.resolveContaining(a.resourceUri)
      if (hit) return hit
    }
    return this.active
  }

  /**
   * The client whose root contains `resourceUri`, longest prefix wins — with NO
   * active-client fallback. Command routing ({@link resolveClient}) falls back
   * to the active client for argument-less invocations; data queries (timeline)
   * must not, or a file outside every client root would silently read history
   * from the wrong workspace.
   */
  resolveContaining(resourceUri: string): PerforceClient | undefined {
    const p = norm(resourceUri)
    let best: PerforceClient | undefined
    let bestLen = -1
    for (const client of this._clients.values()) {
      const r = norm(client.root)
      if ((p === r || p.startsWith(`${r}/`)) && r.length > bestLen) {
        best = client
        bestLen = r.length
      }
    }
    return best
  }

  dispose(): void {
    for (const client of this._clients.values()) client.dispose()
    this._clients.clear()
  }
}
