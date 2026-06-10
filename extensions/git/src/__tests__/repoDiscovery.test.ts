import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { discoverRepos, type DiscoverOptions } from '../repoDiscovery.js'
import { pickStatusBarRoot } from '../extension.js'
import { norm } from '../pathUtil.js'

// Lets a single test force `readdir` to fail for one directory while every other
// fs call (and every other test) uses the real implementation.
const readdirControl = vi.hoisted(() => ({ rejectKey: null as string | null }))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  const key = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  return {
    ...actual,
    readdir: ((path: unknown, options: unknown) => {
      if (
        readdirControl.rejectKey !== null &&
        typeof path === 'string' &&
        key(path) === readdirControl.rejectKey
      ) {
        return Promise.reject(new Error('EACCES'))
      }
      return (actual.readdir as (p: unknown, o: unknown) => unknown)(path, options)
    }) as typeof actual.readdir,
  }
})

const execFileAsync = promisify(execFile)

const tmpRoots: string[] = []

async function git(args: readonly string[], cwd?: string): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Universe Test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Universe Test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    },
  })
  return stdout
}

async function makeWorkspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'ue-git-discover-'))
  tmpRoots.push(root)
  return root
}

/** `git init` a directory (creating it first), then make one commit so it's a real repo. */
async function initRepo(path: string): Promise<void> {
  await mkdir(path, { recursive: true })
  await git(['init'], path)
  await git(['commit', '--allow-empty', '-m', 'initial'], path)
}

const DEFAULT_OPTS: DiscoverOptions = { maxDepth: 3, ignoredFolders: ['node_modules'] }

function rootSet(result: { repos: { root: string }[] }): Set<string> {
  return new Set(result.repos.map((r) => norm(r.root)))
}

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(tmpRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('discoverRepos', () => {
  it('finds the root repo and a nested repo when the workspace root is a repo', async () => {
    const root = await makeWorkspace()
    await initRepo(root)
    const sub = join(root, 'sub')
    await initRepo(sub)

    const result = await discoverRepos(root, DEFAULT_OPTS)
    expect(rootSet(result)).toEqual(new Set([norm(root), norm(sub)]))
    expect(norm(result.mainRoot ?? '')).toBe(norm(root))
  })

  it('finds sibling repos when the workspace root is not a repo', async () => {
    const root = await makeWorkspace()
    const a = join(root, 'a')
    const b = join(root, 'b')
    await initRepo(a)
    await initRepo(b)

    const result = await discoverRepos(root, DEFAULT_OPTS)
    expect(rootSet(result)).toEqual(new Set([norm(a), norm(b)]))
    expect(result.mainRoot).toBeUndefined()
    expect(norm(pickStatusBarRoot(result.repos))).toBe(norm(a))
  })

  it('respects maxDepth', async () => {
    const root = await makeWorkspace()
    const deep = join(root, 'l1', 'l2', 'l3', 'l4')
    await initRepo(deep)

    const atThree = await discoverRepos(root, { ...DEFAULT_OPTS, maxDepth: 3 })
    expect(atThree.repos).toHaveLength(0)

    const unlimited = await discoverRepos(root, { ...DEFAULT_OPTS, maxDepth: -1 })
    expect(rootSet(unlimited)).toEqual(new Set([norm(deep)]))
  })

  it('skips ignored folders', async () => {
    const root = await makeWorkspace()
    await initRepo(join(root, 'node_modules', 'pkg'))
    const kept = join(root, 'pkg')
    await initRepo(kept)

    const result = await discoverRepos(root, DEFAULT_OPTS)
    expect(rootSet(result)).toEqual(new Set([norm(kept)]))
  })

  it('skips hidden folders', async () => {
    const root = await makeWorkspace()
    await initRepo(join(root, '.cache', 'pkg'))
    const kept = join(root, 'pkg')
    await initRepo(kept)

    const result = await discoverRepos(root, DEFAULT_OPTS)
    expect(rootSet(result)).toEqual(new Set([norm(kept)]))
  })

  it('does not scan subfolders when maxDepth is 0', async () => {
    const root = await makeWorkspace()
    await initRepo(join(root, 'sub'))

    const result = await discoverRepos(root, { ...DEFAULT_OPTS, maxDepth: 0 })
    expect(result.repos).toHaveLength(0)
  })

  it('reports a checked-out submodule once, as initialized', async () => {
    const root = await makeWorkspace()
    const origin = join(root, 'origin')
    const main = join(root, 'main')
    await initRepo(origin)
    await initRepo(main)
    // Local-path submodules need the file protocol explicitly allowed.
    await git(['-c', 'protocol.file.allow=always', 'submodule', 'add', origin, 'sub'], main)
    await git(['commit', '-m', 'add submodule'], main)

    const result = await discoverRepos(main, DEFAULT_OPTS)
    const subKey = norm(join(main, 'sub'))
    const matches = result.repos.filter((r) => norm(r.root) === subKey)
    expect(matches).toHaveLength(1)
    expect(matches[0]!.initialized).toBe(true)
  })

  it('keeps scanning when a directory cannot be read', async () => {
    const root = await makeWorkspace()
    const broken = join(root, 'broken')
    const good = join(root, 'good')
    await mkdir(broken, { recursive: true })
    await initRepo(good)

    readdirControl.rejectKey = broken.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
    try {
      const result = await discoverRepos(root, DEFAULT_OPTS)
      expect(rootSet(result)).toEqual(new Set([norm(good)]))
    } finally {
      readdirControl.rejectKey = null
    }
  })
})
