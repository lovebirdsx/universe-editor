/**
 * Discovers every git repository the workspace exposes: the root repo (if the
 * workspace folder itself is one) plus its submodules, plus any independent
 * repositories nested in subfolders.
 *
 * The workspace folder need not be a repository at all — a folder holding
 * several sibling projects is the common multi-repo case. Nested repos are
 * found by a bounded breadth-first scan (mirroring VSCode's
 * `traverseWorkspaceFolder`): cheap `readdir` probing for a `.git` entry, then
 * one `git rev-parse` per candidate to confirm the real toplevel. Shared by
 * `extension.ts` (one Repository / SCM provider per repo) and the Git Graph
 * data source, so both see the same list.
 */
import { readdir } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { detectRepoRoot, gitExec } from './gitService.js'
import { norm } from './pathUtil.js'

type Log = (msg: string) => void

export interface DiscoveredRepo {
  readonly root: string
  readonly name: string
  /** A `-` prefix in `git submodule status` means the submodule isn't checked out (no `.git`). */
  readonly initialized: boolean
}

export interface DiscoverOptions {
  /** Subfolder depth to scan. 0 = root only (no scan); -1 = unlimited. */
  readonly maxDepth: number
  /** Folder names skipped during the scan (matched case-insensitively). */
  readonly ignoredFolders: readonly string[]
}

export interface DiscoverResult {
  readonly repos: DiscoveredRepo[]
  /** The root repo when the workspace folder itself is a repository, else undefined. */
  readonly mainRoot: string | undefined
}

/**
 * BFS over subfolders, returning directories that contain a `.git` entry. A
 * `.git` may be a directory (normal repo) or a file (submodule / worktree), so
 * we only check the name. A discovered repo's subtree isn't descended into.
 */
async function traverse(
  root: string,
  maxDepth: number,
  ignoredFolders: readonly string[],
  log?: Log,
): Promise<string[]> {
  const ignored = new Set(ignoredFolders.map((f) => f.toLowerCase()))
  const candidates: string[] = []
  const queue: { path: string; depth: number }[] = [{ path: root, depth: 0 }]
  while (queue.length) {
    const cur = queue.shift()!
    let entries
    try {
      entries = await readdir(cur.path, { withFileTypes: true })
    } catch (e) {
      log?.(`[discover] skip unreadable ${cur.path}: ${String(e)}`)
      continue
    }
    if (cur.depth > 0 && entries.some((e) => e.name === '.git')) {
      candidates.push(cur.path)
      continue
    }
    if (cur.depth < maxDepth || maxDepth === -1) {
      for (const e of entries) {
        if (!e.isDirectory()) continue
        if (e.name.startsWith('.')) continue
        if (ignored.has(e.name.toLowerCase())) continue
        queue.push({ path: join(cur.path, e.name), depth: cur.depth + 1 })
      }
    }
  }
  return candidates
}

/** Parse `git submodule status` (one level deep, matching the command's output). */
async function readSubmodules(mainRoot: string, log?: Log): Promise<DiscoveredRepo[]> {
  const out: DiscoveredRepo[] = []
  const res = await gitExec(['submodule', 'status'], mainRoot, log)
  if (res.exitCode === 0) {
    for (const line of res.stdout.split('\n')) {
      // Format: "<flag><sha> <path> (<describe>)"; the flag is one of -, +, U or a space.
      const m = line.match(/^([-+U ]?)[0-9a-f]+\s+(.+?)(?:\s+\(.*\))?$/)
      if (m && m[2]) {
        out.push({ root: join(mainRoot, m[2]), name: m[2], initialized: m[1] !== '-' })
      }
    }
  }
  return out
}

export async function discoverRepos(
  workspaceRoot: string,
  opts: DiscoverOptions,
  log?: Log,
): Promise<DiscoverResult> {
  const byKey = new Map<string, DiscoveredRepo>()
  const addRepo = (repo: DiscoveredRepo): void => {
    const key = norm(repo.root)
    const existing = byKey.get(key)
    if (!existing) byKey.set(key, repo)
    else if (!existing.initialized && repo.initialized)
      byKey.set(key, { ...existing, initialized: true })
  }

  const mainRoot = await detectRepoRoot(workspaceRoot)
  if (mainRoot) {
    addRepo({ root: mainRoot, name: basename(mainRoot), initialized: true })
    for (const s of await readSubmodules(mainRoot, log)) addRepo(s)
  }

  if (opts.maxDepth !== 0) {
    const candidates = await traverse(workspaceRoot, opts.maxDepth, opts.ignoredFolders, log)
    await Promise.all(
      candidates.map(async (dir) => {
        const confirmed = await detectRepoRoot(dir)
        if (confirmed) addRepo({ root: confirmed, name: basename(confirmed), initialized: true })
      }),
    )
  }

  return { repos: [...byKey.values()], mainRoot }
}
