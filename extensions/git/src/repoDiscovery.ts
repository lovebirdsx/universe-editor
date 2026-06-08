/**
 * Discovers the repositories the workspace exposes: the main repo plus any
 * submodules registered in it. Shared by `extension.ts` (one Repository / SCM
 * provider per repo) and the Git Graph data source, so both see the same list.
 *
 * The workspace has a single root, so independent sibling repos don't arise;
 * submodules are the realistic multi-repo case. Discovery is one level deep
 * (matching `git submodule status` without `--recursive`).
 */
import { basename, join } from 'node:path'
import { gitExec } from './gitService.js'

export interface DiscoveredRepo {
  readonly root: string
  readonly name: string
  /** A `-` prefix in `git submodule status` means the submodule isn't checked out (no `.git`). */
  readonly initialized: boolean
}

export async function discoverRepos(
  mainRoot: string,
  log?: (msg: string) => void,
): Promise<DiscoveredRepo[]> {
  const repos: DiscoveredRepo[] = [{ root: mainRoot, name: basename(mainRoot), initialized: true }]
  const res = await gitExec(['submodule', 'status'], mainRoot, log)
  if (res.exitCode === 0) {
    for (const line of res.stdout.split('\n')) {
      // Format: "<flag><sha> <path> (<describe>)"; the flag is one of -, +, U or a space.
      const m = line.match(/^([-+U ]?)[0-9a-f]+\s+(.+?)(?:\s+\(.*\))?$/)
      if (m && m[2]) {
        repos.push({ root: join(mainRoot, m[2]), name: m[2], initialized: m[1] !== '-' })
      }
    }
  }
  return repos
}
