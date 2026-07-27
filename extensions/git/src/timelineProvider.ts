/**
 * GitTimelineProvider — TimelineProvider backed by `git log --follow` for a
 * single file (the Universe counterpart of VSCode's `extensions/git`
 * timelineProvider). Registered for the `file` scheme; the built-in Timeline
 * view pulls pages, merges them with other sources, and runs each item's
 * command on click.
 *
 * Paging: each request fetches `limit + 1` commits; the extra record both
 * proves another page exists and becomes the cursor — the next page's
 * `git log <cursor>` starts at that commit, so pages chain without overlap.
 * The first page is headed by an "Uncommitted Changes" entry when the file's
 * working tree differs from HEAD (toggleable via
 * `git.timeline.showUncommitted`). The difference is judged by
 * `git diff --quiet HEAD` itself: a content compare would false-positive on
 * CRLF working trees, and untracked paths yield an empty diff so they get no
 * entry — matching VSCode's working-tree-group check.
 *
 * Also owns the feature's commands: `git.timeline.openDiff` (item click → diff
 * against the previous version) and the Copy Commit ID / Message context-menu
 * commands (clipboard goes through the renderer's `_workbench.writeClipboard`).
 */
import { readFile, stat } from 'node:fs/promises'
import { basename, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  commands,
  workspace,
  type CancellationToken,
  type Disposable,
  type Event,
  type Timeline,
  type TimelineChangeEvent,
  type TimelineItem,
  type TimelineOptions,
  type TimelineProvider,
} from '@universe-editor/extension-api'
import { gitExec } from './gitService.js'
import { localize } from './nls.js'
import type { Repository } from './repository.js'
import type { RepositoryManager } from './repositoryManager.js'

const FIELD = '\x1f'

interface LogCommit {
  readonly hash: string
  readonly author: string
  readonly email: string
  /** Epoch seconds (`%at`). */
  readonly at: number
  readonly subject: string
}

function parseCommit(record: string): LogCommit {
  const [hash, author, email, at, ...subjectParts] = record.split(FIELD)
  return {
    hash: hash ?? '',
    author: author ?? '',
    email: email ?? '',
    at: Number(at ?? 0),
    // `%s` never contains FIELD, but rejoin defensively.
    subject: subjectParts.join(FIELD),
  }
}

const AGO_UNITS: ReadonlyArray<{ limit: number; div: number; key: string; def: string }> = [
  { limit: 60, div: 1, key: 'secondsAgo', def: '{0} second{s} ago' },
  { limit: 3600, div: 60, key: 'minutesAgo', def: '{0} minute{s} ago' },
  { limit: 86400, div: 3600, key: 'hoursAgo', def: '{0} hour{s} ago' },
  { limit: 604800, div: 86400, key: 'daysAgo', def: '{0} day{s} ago' },
  { limit: 2629800, div: 604800, key: 'weeksAgo', def: '{0} week{s} ago' },
  { limit: 31557600, div: 2629800, key: 'monthsAgo', def: '{0} month{s} ago' },
  { limit: Infinity, div: 31557600, key: 'yearsAgo', def: '{0} year{s} ago' },
]

export function relativeTimeAgo(timestamp: number): string {
  const elapsed = Math.max(1, Math.floor((Date.now() - timestamp) / 1000))
  for (const unit of AGO_UNITS) {
    if (elapsed < unit.limit) {
      const n = Math.max(1, Math.floor(elapsed / unit.div))
      return localize(`git.timeline.${unit.key}`, unit.def, { 0: n, s: n === 1 ? '' : 's' })
    }
  }
  // Unreachable: the years unit has no limit.
  return ''
}

/** Payload of the `git.timeline.openDiff` item command. */
interface OpenDiffArg {
  readonly uri?: string
  /** Empty string = the working tree (Uncommitted Changes entry). */
  readonly currentHash?: string
  /** Git revision of the previous version; `HEAD` for the working-tree entry. */
  readonly previousHash?: string
}

export class GitTimelineProvider implements TimelineProvider {
  readonly id = 'git-history'
  readonly label = localize('git.timeline.providerLabel', 'Git History')

  private readonly _listeners = new Set<(e: TimelineChangeEvent) => void>()
  readonly onDidChange: Event<TimelineChangeEvent> = (listener) => {
    this._listeners.add(listener)
    return { dispose: () => this._listeners.delete(listener) }
  }

  constructor(
    private readonly _mgr: RepositoryManager,
    private readonly _log?: (msg: string) => void,
  ) {}

  /** A repo refresh (commit / index / working-tree change) invalidates every page. */
  trackRepo(repo: Repository): Disposable {
    return repo.onDidChange(() => {
      for (const l of this._listeners) l({ reset: true })
    })
  }

  async provideTimeline(
    uri: string,
    options: TimelineOptions,
    _token: CancellationToken,
  ): Promise<Timeline | undefined> {
    const absPath = fileURLToPath(uri)
    const repo = this._mgr.resolveRepo({ resourceUri: absPath })
    if (!repo) return undefined
    const rel = relative(repo.root, absPath).replace(/\\/g, '/')
    const limit = options.limit ?? 50

    const items: TimelineItem[] = []
    if (options.cursor === undefined) {
      const uncommitted = await this._uncommittedItem(repo, absPath)
      if (uncommitted) items.push(uncommitted)
    }

    const args = [
      'log',
      '-z',
      '--follow',
      `--format=%H${FIELD}%an${FIELD}%ae${FIELD}%at${FIELD}%s`,
      `--max-count=${limit + 1}`,
      ...(options.cursor !== undefined ? [options.cursor] : []),
      '--',
      rel,
    ]
    const res = await gitExec(args, repo.root, this._log)
    if (res.exitCode !== 0) {
      // Unborn branch or an otherwise unreadable path — the working-tree entry
      // (if any) is all the history there is.
      return { items }
    }

    const records = res.stdout.split('\0').filter(Boolean)
    const hasMore = records.length > limit
    const commits = records.slice(0, limit).map(parseCommit)
    // The limit+1 probe record chains the page edge: it is the previous version
    // of the page's last item and the cursor the next page starts from.
    const probe = hasMore ? parseCommit(records[limit] ?? '') : undefined
    commits.forEach((commit, i) => {
      const next = i + 1 < commits.length ? commits[i + 1] : probe
      items.push(commitItem(commit, next?.hash ?? `${commit.hash}^`, absPath))
    })
    return { items, ...(probe !== undefined ? { cursor: probe.hash } : {}) }
  }

  /** The "Uncommitted Changes" entry, when a tracked file's working tree differs from HEAD. */
  private async _uncommittedItem(
    repo: Repository,
    absPath: string,
  ): Promise<TimelineItem | undefined> {
    const cfg = workspace.getConfiguration('git')
    if ((await cfg.get('timeline.showUncommitted', true)) === false) return undefined

    // Let git judge the difference. A blob-vs-file content compare
    // false-positives on CRLF working trees (autocrlf normalizes them for
    // real diffs); untracked paths yield an empty diff, so they get no entry
    // either — matching VSCode's working-tree-group check. Exit 1 = differs;
    // 0 = clean; anything else (e.g. unborn HEAD) is treated as no entry.
    const rel = relative(repo.root, absPath).replace(/\\/g, '/')
    const diff = await gitExec(['diff', '--quiet', 'HEAD', '--', rel], repo.root, this._log)
    if (diff.exitCode !== 1) return undefined

    const st = await stat(absPath).catch(() => undefined)
    const timestamp = st?.mtimeMs ?? Date.now()
    return {
      label: localize('git.timeline.uncommittedChanges', 'Uncommitted Changes'),
      ...(st !== undefined ? { description: relativeTimeAgo(st.mtimeMs) } : {}),
      timestamp,
      contextValue: 'git:file:working',
      command: {
        command: 'git.timeline.openDiff',
        title: localize('git.timeline.openComparison', 'Open Comparison'),
        arguments: [{ uri: absPath, currentHash: '', previousHash: 'HEAD' }],
      },
    }
  }
}

function commitItem(commit: LogCommit, previousHash: string, absPath: string): TimelineItem {
  const timestamp = commit.at * 1000
  return {
    id: commit.hash,
    label: commit.subject,
    description: relativeTimeAgo(timestamp),
    tooltip: `${commit.hash}\n${commit.author} <${commit.email}>\n${new Date(timestamp).toLocaleString()}\n\n${commit.subject}`,
    timestamp,
    themeIcon: 'git-commit',
    contextValue: 'git:file:commit',
    command: {
      command: 'git.timeline.openDiff',
      title: localize('git.timeline.openComparison', 'Open Comparison'),
      arguments: [{ uri: absPath, currentHash: commit.hash, previousHash }],
    },
  }
}

/** The timeline feature's commands (item click + context menu entries). */
export function createGitTimelineCommands(
  mgr: RepositoryManager,
  log?: (msg: string) => void,
): Disposable[] {
  return [
    commands.registerCommand('git.timeline.openDiff', async (arg: unknown) => {
      const { uri, currentHash, previousHash } = (arg ?? {}) as OpenDiffArg
      if (!uri || currentHash === undefined) return
      const repo = mgr.resolveRepo({ resourceUri: uri })
      if (!repo) return
      const rel = relative(repo.root, uri).replace(/\\/g, '/')

      // A renamed file has no blob at the old path on the far side; the empty
      // fallback renders the entry as added/deleted rather than failing.
      let original = ''
      if (previousHash) {
        const res = await gitExec(['show', `${previousHash}:${rel}`], repo.root, log)
        if (res.exitCode === 0) original = res.stdout
      }
      let modified = ''
      if (currentHash === '') {
        try {
          modified = await readFile(uri, 'utf8')
        } catch {
          modified = ''
        }
      } else {
        const res = await gitExec(['show', `${currentHash}:${rel}`], repo.root, log)
        if (res.exitCode === 0) modified = res.stdout
      }

      const fileUrl = pathToFileURL(uri).href
      await commands.executeCommand('_workbench.openDiff', {
        title:
          currentHash === ''
            ? `${basename(uri)} (Working Tree)`
            : `${basename(uri)} (${currentHash.slice(0, 7)})`,
        originalUri: fileUrl,
        original,
        modified,
        pinned: false,
        preserveFocus: false,
        openableUri: fileUrl,
        // Empty currentHash means the working tree — its side tracks live edits;
        // a committed hash is a frozen blob and must not be live-synced.
        ...(currentHash === '' && { liveModified: true }),
      })
    }),

    commands.registerCommand('git.timeline.copyCommitId', (item: unknown) => {
      const id = (item as { id?: string } | undefined)?.id
      if (id) return commands.executeCommand('_workbench.writeClipboard', id)
      return undefined
    }),

    commands.registerCommand('git.timeline.copyCommitMessage', (item: unknown) => {
      const label = (item as { label?: string } | undefined)?.label
      if (label) return commands.executeCommand('_workbench.writeClipboard', label)
      return undefined
    }),
  ]
}
