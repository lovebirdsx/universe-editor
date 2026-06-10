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
import { Repository } from './repository.js'
import { norm } from './pathUtil.js'

interface RepoArg {
  readonly rootUri?: string
  readonly resourceUri?: string
}

export class RepositoryManager {
  private readonly _repos = new Map<string, Repository>()

  constructor(
    readonly mainRoot: string,
    private readonly _log?: (msg: string) => void,
  ) {}

  get main(): Repository | undefined {
    return this._repos.get(norm(this.mainRoot))
  }

  get all(): Repository[] {
    return [...this._repos.values()]
  }

  add(root: string, opts: { statusBar?: boolean; label?: string }): Repository {
    const key = norm(root)
    const existing = this._repos.get(key)
    if (existing) return existing
    const repo = new Repository(root, this._log, opts)
    this._repos.set(key, repo)
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
    return this.main
  }

  dispose(): void {
    for (const repo of this._repos.values()) repo.dispose()
    this._repos.clear()
  }
}
