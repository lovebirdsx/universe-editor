/**
 * Owns the set of git repositories surfaced through the SCM API — the main repo
 * plus any submodules — and routes a command's argument to the right one.
 *
 * All git source controls share the id `git`, so the renderer can't disambiguate
 * repos by id. Routing keys off each repo's unique root: provider / group level
 * commands carry `{ rootUri }`; resource / folder level commands carry an
 * absolute `resourceUri`, matched to the repo with the longest containing root
 * (a submodule root is a sub-path of the main root, so longest wins).
 */
import type { Disposable } from '@universe-editor/extension-api'
import { Repository } from './repository.js'
import { isSubPath, norm } from './pathUtil.js'

interface RepoArg {
  readonly rootUri?: string
  readonly resourceUri?: string
}

export class RepositoryManager {
  private readonly _repos = new Map<string, Repository>()
  private readonly _addListeners = new Set<(repo: Repository) => void>()
  /** The repo argument-less commands (command palette, keybindings, status bar)
   *  target. Mirrors the SCM view's selected repo, pushed via `git.setActiveRepo`;
   *  defaults to the main repo until the renderer syncs a selection. */
  private _activeRoot: string
  /** Mutable so the workspace folder becoming a repo after startup (`git init`
   *  in an already-open folder) can be promoted to main. */
  private _mainRoot: string

  constructor(
    mainRoot: string,
    private readonly _log?: (msg: string) => void,
  ) {
    this._mainRoot = mainRoot
    this._activeRoot = mainRoot
  }

  get mainRoot(): string {
    return this._mainRoot
  }

  get main(): Repository | undefined {
    return this._repos.get(norm(this._mainRoot))
  }

  /** The currently active repo (falls back to main when the selection is gone). */
  get active(): Repository | undefined {
    return this._repos.get(norm(this._activeRoot)) ?? this.main
  }

  /** Point argument-less commands at `root` when it names a known repo. */
  setActive(root: string | undefined): void {
    if (root && this._repos.has(norm(root))) this._activeRoot = root
  }

  /** Promote an already-added repo to main (late `git init` in the workspace root). */
  setMainRoot(root: string): void {
    if (this._repos.has(norm(root))) {
      this._mainRoot = root
      this._activeRoot = root
    }
  }

  has(root: string): boolean {
    return this._repos.has(norm(root))
  }

  /** Fired when `add` surfaces a repo the manager didn't already know. */
  onDidAdd(listener: (repo: Repository) => void): Disposable {
    this._addListeners.add(listener)
    return { dispose: () => this._addListeners.delete(listener) }
  }

  get all(): Repository[] {
    return [...this._repos.values()]
  }

  /**
   * Repos nested under `root` — its submodules (including nested ones), which a
   * `submodule update --recursive` in `root` moves. Linked worktrees live in a
   * sibling `<repo>.worktrees/` directory, so they never match this prefix.
   */
  submodulesOf(root: string): Repository[] {
    return this.all.filter((repo) => isSubPath(root, repo.root))
  }

  add(root: string, opts: { statusBar?: boolean; label?: string }): Repository {
    const key = norm(root)
    const existing = this._repos.get(key)
    if (existing) return existing
    const repo = new Repository(root, this._log, {
      ...(opts.label !== undefined ? { label: opts.label } : {}),
      onSubmodulesUpdated: () => {
        for (const sub of this.submodulesOf(root)) {
          void sub
            .refresh()
            .catch((err) => this._log?.(`[git] submodule refresh failed: ${String(err)}`))
        }
      },
    })
    this._repos.set(key, repo)
    for (const l of this._addListeners) l(repo)
    return repo
  }

  resolveRepo(arg: unknown): Repository | undefined {
    const a = (arg ?? undefined) as RepoArg | undefined
    if (a?.rootUri) {
      const hit = this._repos.get(norm(a.rootUri))
      if (hit) return hit
    }
    if (a?.resourceUri) {
      const p = norm(a.resourceUri)
      let best: Repository | undefined
      let bestLen = -1
      for (const repo of this._repos.values()) {
        const r = norm(repo.root)
        if ((p === r || p.startsWith(`${r}/`)) && r.length > bestLen) {
          best = repo
          bestLen = r.length
        }
      }
      if (best) return best
    }
    return this.active
  }

  dispose(): void {
    this._addListeners.clear()
    for (const repo of this._repos.values()) repo.dispose()
    this._repos.clear()
  }
}
