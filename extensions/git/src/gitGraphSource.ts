/**
 * Git Graph data source. Pulls the commit DAG, refs and HEAD via `gitExec` and
 * assembles the JSON the renderer's Git Graph view needs. Read-only: no command
 * here mutates the repository.
 *
 * The returned shapes mirror the `GitGraph*Dto` types in
 * `@universe-editor/extensions-common`; they're re-declared locally so this
 * esbuild-bundled extension doesn't pull that package (and its platform dep)
 * into its bundle.
 */
import { basename, join } from 'node:path'
import { gitExec } from './gitService.js'
import { discoverRepos } from './repoDiscovery.js'

/** Field separator inside a record; record separator is NUL (`git -z`). */
const FIELD = '\x1f'

export interface GitGraphTag {
  name: string
  annotated: boolean
}

export interface GitGraphRemote {
  name: string
  remote: string | null
}

export interface GitGraphStash {
  selector: string
  baseHash: string
}

/** A repository the Git Graph view can target (main repo or a submodule). */
export interface GitGraphRepo {
  root: string
  name: string
}

export interface GitGraphCommit {
  hash: string
  parents: string[]
  author: string
  email: string
  date: number
  message: string
  heads: string[]
  tags: GitGraphTag[]
  remotes: GitGraphRemote[]
  stash: GitGraphStash | null
}

export interface GitGraphLoadOptions {
  maxCommits?: number
  order?: 'date' | 'author-date' | 'topo'
  includeRemotes?: boolean
}

export interface GitGraphLoadResult {
  commits: GitGraphCommit[]
  head: string | null
  headName: string | null
  moreAvailable: boolean
  uncommittedChanges: number
}

export interface GitGraphFileChange {
  status: string
  path: string
  oldPath: string | null
}

export interface GitGraphCommitDetails {
  hash: string
  parents: string[]
  author: string
  authorEmail: string
  authorDate: number
  committer: string
  committerEmail: string
  committerDate: number
  body: string
  files: GitGraphFileChange[]
}

export interface GitGraphFileDiffRequest {
  fromHash: string
  toHash: string
  path: string
  oldPath?: string
  status: string
}

export interface GitGraphFileDiffContent {
  title: string
  /** Absolute path on disk, used to derive the diff editor's URI and language. */
  path: string
  original: string
  modified: string
}

/** The empty tree object — diff base for the very first commit's added files. */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'

type Log = ((msg: string) => void) | undefined

function orderFlag(order: GitGraphLoadOptions['order']): string {
  switch (order) {
    case 'author-date':
      return '--author-date-order'
    case 'topo':
      return '--topo-order'
    default:
      return '--date-order'
  }
}

interface Refs {
  head: string | null
  headName: string | null
  /** commit hash → local branch names */
  heads: Map<string, string[]>
  /** commit hash → tags */
  tags: Map<string, GitGraphTag[]>
  /** commit hash → remote-tracking branches */
  remotes: Map<string, GitGraphRemote[]>
}

function push<T>(map: Map<string, T[]>, key: string, value: T): void {
  const existing = map.get(key)
  if (existing) existing.push(value)
  else map.set(key, [value])
}

async function getRefs(root: string, log: Log): Promise<Refs> {
  const heads = new Map<string, string[]>()
  const tags = new Map<string, GitGraphTag[]>()
  const remotes = new Map<string, GitGraphRemote[]>()

  const res = await gitExec(
    [
      'for-each-ref',
      `--format=%(objectname)${FIELD}%(refname)${FIELD}%(*objectname)`,
      'refs/heads',
      'refs/remotes',
      'refs/tags',
    ],
    root,
    log,
  )
  if (res.exitCode === 0) {
    for (const line of res.stdout.split('\n')) {
      if (!line) continue
      const [objectName, refName, derefName] = line.split(FIELD)
      if (!objectName || !refName) continue
      if (refName.startsWith('refs/heads/')) {
        push(heads, objectName, refName.slice('refs/heads/'.length))
      } else if (refName.startsWith('refs/remotes/')) {
        const name = refName.slice('refs/remotes/'.length)
        if (name.endsWith('/HEAD')) continue // symbolic origin/HEAD — skip
        const remote = name.includes('/') ? name.slice(0, name.indexOf('/')) : null
        push(remotes, objectName, { name, remote })
      } else if (refName.startsWith('refs/tags/')) {
        // Annotated tags resolve to a tag object; %(*objectname) dereferences to
        // the commit they ultimately point at.
        const target = derefName || objectName
        push(tags, target, {
          name: refName.slice('refs/tags/'.length),
          annotated: Boolean(derefName),
        })
      }
    }
  }

  const headRes = await gitExec(['rev-parse', 'HEAD'], root, log)
  const head = headRes.exitCode === 0 ? headRes.stdout.trim() || null : null
  const nameRes = await gitExec(['symbolic-ref', '--short', '-q', 'HEAD'], root, log)
  const headName = nameRes.exitCode === 0 ? nameRes.stdout.trim() || null : null

  return { head, headName, heads, tags, remotes }
}

export async function getCommits(
  root: string,
  opts: GitGraphLoadOptions,
  log?: (msg: string) => void,
): Promise<GitGraphLoadResult> {
  const max = opts.maxCommits ?? 300
  const includeRemotes = opts.includeRemotes !== false

  const args = [
    'log',
    '-z',
    `--format=%H${FIELD}%P${FIELD}%an${FIELD}%ae${FIELD}%at${FIELD}%s`,
    `--max-count=${max + 1}`,
    orderFlag(opts.order),
    '--branches',
    '--tags',
  ]
  if (includeRemotes) args.push('--remotes')
  args.push('HEAD')

  const res = await gitExec(args, root, log)
  const refs = await getRefs(root, log)
  const uncommittedChanges = await countUncommitted(root, log)

  if (res.exitCode !== 0) {
    // Unborn repo (no commits yet) or other failure — surface an empty graph.
    return {
      commits: [],
      head: refs.head,
      headName: refs.headName,
      moreAvailable: false,
      uncommittedChanges,
    }
  }

  const records = res.stdout.split('\0').filter(Boolean)
  const moreAvailable = records.length > max
  const commits: GitGraphCommit[] = records.slice(0, max).map((record) => {
    const [hash, parentsStr, author, email, at, ...subjectParts] = record.split(FIELD)
    // `%s` never contains FIELD, but rejoin defensively.
    const message = subjectParts.join(FIELD)
    const h = hash ?? ''
    return {
      hash: h,
      parents: parentsStr ? parentsStr.split(' ').filter(Boolean) : [],
      author: author ?? '',
      email: email ?? '',
      date: Number(at ?? 0),
      message,
      heads: refs.heads.get(h) ?? [],
      tags: refs.tags.get(h) ?? [],
      remotes: refs.remotes.get(h) ?? [],
      stash: null,
    }
  })

  const stashes = await getStashes(root, log)
  for (const stash of stashes) mergeByDateDesc(commits, stash)

  return { commits, head: refs.head, headName: refs.headName, moreAvailable, uncommittedChanges }
}

/**
 * Repositories the Git Graph view can switch between: the main repo plus any
 * submodules registered in it. Thin wrapper over the shared `discoverRepos`.
 */
export async function getRepos(
  mainRoot: string,
  log?: (msg: string) => void,
): Promise<GitGraphRepo[]> {
  const repos = await discoverRepos(mainRoot, log)
  return repos.map(({ root, name }) => ({ root, name }))
}

/** Count changed files in the working tree (one porcelain line per path). */
async function countUncommitted(root: string, log: Log): Promise<number> {
  const res = await gitExec(['status', '--porcelain'], root, log)
  if (res.exitCode !== 0) return 0
  return res.stdout.split('\n').filter((l) => l.length > 0).length
}

/** Stash entries as graph nodes, connected to the commit they were created on. */
async function getStashes(root: string, log: Log): Promise<GitGraphCommit[]> {
  const res = await gitExec(
    ['stash', 'list', '-z', `--format=%H${FIELD}%P${FIELD}%gd${FIELD}%ct${FIELD}%s`],
    root,
    log,
  )
  if (res.exitCode !== 0) return []
  const stashes: GitGraphCommit[] = []
  for (const record of res.stdout.split('\0').filter(Boolean)) {
    const [hash, parentsStr, selector, ct, ...subjectParts] = record.split(FIELD)
    if (!hash || !selector) continue
    // A stash is a merge commit; only its first parent (the base commit) is part
    // of the visible history, so drop the index/untracked pseudo-parents.
    const baseHash = parentsStr ? (parentsStr.split(' ').filter(Boolean)[0] ?? '') : ''
    stashes.push({
      hash,
      parents: baseHash ? [baseHash] : [],
      author: '',
      email: '',
      date: Number(ct ?? 0),
      message: subjectParts.join(FIELD),
      heads: [],
      tags: [],
      remotes: [],
      stash: { selector, baseHash },
    })
  }
  return stashes
}

/** Insert a node into a newest-first commit list, ordered by date. */
function mergeByDateDesc(commits: GitGraphCommit[], node: GitGraphCommit): void {
  let i = 0
  while (i < commits.length && commits[i]!.date >= node.date) i++
  commits.splice(i, 0, node)
}

/**
 * The working tree's changes vs HEAD: tracked file changes plus untracked files
 * (reported with status `?`). Used by the synthetic "uncommitted changes" node.
 */
export async function getUncommittedChanges(
  root: string,
  log?: (msg: string) => void,
): Promise<GitGraphFileChange[]> {
  const tracked = await gitExec(
    ['diff', '--name-status', '--find-renames', '-z', 'HEAD'],
    root,
    log,
  )
  const files = tracked.exitCode === 0 ? parseNameStatusZ(tracked.stdout) : []
  const untracked = await gitExec(['ls-files', '--others', '--exclude-standard', '-z'], root, log)
  if (untracked.exitCode === 0) {
    for (const path of untracked.stdout.split('\0').filter(Boolean)) {
      files.push({ status: '?', path, oldPath: null })
    }
  }
  return files
}

/** Parse `git diff --name-status -z` output into structured file changes. */
function parseNameStatusZ(out: string): GitGraphFileChange[] {
  const parts = out.split('\0')
  const files: GitGraphFileChange[] = []
  let i = 0
  while (i < parts.length) {
    const token = parts[i]
    if (!token) {
      i++
      continue
    }
    const letter = token.charAt(0)
    if (letter === 'R' || letter === 'C') {
      files.push({ status: letter, path: parts[i + 2] ?? '', oldPath: parts[i + 1] ?? null })
      i += 3
    } else {
      files.push({ status: letter, path: parts[i + 1] ?? '', oldPath: null })
      i += 2
    }
  }
  return files
}

export async function getCommitDetails(
  root: string,
  hash: string,
  log?: (msg: string) => void,
): Promise<GitGraphCommitDetails | null> {
  const fmt = `%H${FIELD}%P${FIELD}%an${FIELD}%ae${FIELD}%at${FIELD}%cn${FIELD}%ce${FIELD}%ct${FIELD}%B`
  const res = await gitExec(['show', '-s', `--format=${fmt}`, hash], root, log)
  if (res.exitCode !== 0) return null
  const fields = res.stdout.split(FIELD)
  const parents = (fields[1] ?? '').split(' ').filter(Boolean)
  const body = fields.slice(8).join(FIELD).replace(/\n+$/, '')

  const filesRes =
    parents.length > 0
      ? await gitExec(
          ['diff', '--name-status', '--find-renames', '-z', parents[0]!, hash],
          root,
          log,
        )
      : await gitExec(
          [
            'diff-tree',
            '--root',
            '--no-commit-id',
            '--name-status',
            '--find-renames',
            '-r',
            '-z',
            hash,
          ],
          root,
          log,
        )
  const files = filesRes.exitCode === 0 ? parseNameStatusZ(filesRes.stdout) : []

  return {
    hash: fields[0] ?? hash,
    parents,
    author: fields[2] ?? '',
    authorEmail: fields[3] ?? '',
    authorDate: Number(fields[4] ?? 0),
    committer: fields[5] ?? '',
    committerEmail: fields[6] ?? '',
    committerDate: Number(fields[7] ?? 0),
    body,
    files,
  }
}

export async function compareCommits(
  root: string,
  from: string,
  to: string,
  log?: (msg: string) => void,
): Promise<GitGraphFileChange[]> {
  const res = await gitExec(['diff', '--name-status', '--find-renames', '-z', from, to], root, log)
  return res.exitCode === 0 ? parseNameStatusZ(res.stdout) : []
}

/** Fetch both sides of a file diff (blob contents) for `_workbench.openDiff`. */
export async function getFileDiffContent(
  root: string,
  req: GitGraphFileDiffRequest,
  log?: (msg: string) => void,
): Promise<GitGraphFileDiffContent> {
  const status = req.status.charAt(0)
  const basePath = req.oldPath ?? req.path

  let original = ''
  if (status !== 'A') {
    const from = req.fromHash || EMPTY_TREE
    const res = await gitExec(['show', `${from}:${basePath}`], root, log)
    if (res.exitCode === 0) original = res.stdout
  }

  let modified = ''
  if (status !== 'D') {
    const res = await gitExec(['show', `${req.toHash}:${req.path}`], root, log)
    if (res.exitCode === 0) modified = res.stdout
  }

  return {
    title: `${basename(req.path)} (${req.fromHash.slice(0, 7)} ↔ ${req.toHash.slice(0, 7)})`,
    path: join(root, req.path),
    original,
    modified,
  }
}
