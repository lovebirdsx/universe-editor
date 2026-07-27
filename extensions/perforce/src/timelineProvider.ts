/**
 * PerforceTimelineProvider — TimelineProvider backed by `p4 filelog` for a
 * single file (the Perforce counterpart of the git extension's
 * GitTimelineProvider). Registered for the `file` scheme; the built-in Timeline
 * view pulls pages, merges them with other sources, and runs each item's
 * command on click.
 *
 * Paging mirrors git's limit+1 probe: each request fetches `limit + 1`
 * revisions; the extra record both proves another page exists and becomes the
 * cursor — `${depotFile}#${probe.rev}`, which the next page echoes back as the
 * upper bound (`p4 filelog file#N` lists #N and older, so the probe reappears
 * as the next page's first row, exactly like `git log <cursor>`). Encoding the
 * depot path in the cursor saves a re-`fstat` on subsequent pages.
 *
 * The first page is headed by a "Pending Changes" entry when the working tree
 * diverges from the have revision — either the file is open (fstat reports an
 * action) or it drifted unopened (`p4 diff -se`, the reconcile case). Toggleable
 * via `perforce.timeline.showPending`.
 *
 * Also owns the feature's commands: `perforce.timeline.openDiff` (item click →
 * diff against the previous revision / have revision) and
 * `perforce.timeline.copyChangelistNumber` (context menu).
 */
import { readFile, stat } from 'node:fs/promises'
import { basename } from 'node:path'
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
import { filelogLabel, type FilelogRevision } from './filelogParser.js'
import { statusFromAction, fileDiffRevs, displayPath } from './p4GraphParser.js'
import { localize } from './nls.js'
import type { PerforceClient } from './client.js'
import type { ClientManager } from './clientManager.js'

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
      return localize(`perforce.timeline.${unit.key}`, unit.def, { 0: n, s: n === 1 ? '' : 's' })
    }
  }
  // Unreachable: the years unit has no limit.
  return ''
}

/** Payload of the `perforce.timeline.openDiff` item command. */
interface OpenDiffArg {
  readonly uri?: string
  readonly depotFile?: string
  /** The revision the row represents (absent for the pending entry). */
  readonly rev?: string
  readonly action?: string
  readonly change?: string
  /** Have revision for the pending entry's left side. */
  readonly haveRev?: string
  /** True for the working-tree "Pending Changes" entry. */
  readonly pending?: boolean
}

/** Decode a `${depotFile}#${rev}` page cursor. */
function parseCursor(cursor: string): { depotFile: string; rev: number } | undefined {
  const i = cursor.lastIndexOf('#')
  if (i <= 0) return undefined
  const rev = Number(cursor.slice(i + 1))
  if (!Number.isInteger(rev) || rev < 1) return undefined
  return { depotFile: cursor.slice(0, i), rev }
}

export class PerforceTimelineProvider implements TimelineProvider {
  readonly id = 'perforce-history'
  readonly label = localize('perforce.timeline.providerLabel', 'Perforce History')

  private readonly _listeners = new Set<(e: TimelineChangeEvent) => void>()
  readonly onDidChange: Event<TimelineChangeEvent> = (listener) => {
    this._listeners.add(listener)
    return { dispose: () => this._listeners.delete(listener) }
  }

  constructor(
    private readonly _mgr: ClientManager,
    private readonly _log?: (msg: string) => void,
  ) {}

  /**
   * A client refresh invalidates every page. The client's change event also
   * fires on busy-label push/pop around each p4 op, so debounce to collapse a
   * mutation's burst into one view reload.
   */
  trackClient(client: PerforceClient): Disposable {
    let timer: ReturnType<typeof setTimeout> | undefined
    const sub = client.onDidChange(() => {
      if (timer !== undefined) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = undefined
        for (const l of this._listeners) l({ reset: true })
      }, 200)
    })
    return {
      dispose: () => {
        if (timer !== undefined) clearTimeout(timer)
        sub.dispose()
      },
    }
  }

  async provideTimeline(
    uri: string,
    options: TimelineOptions,
    _token: CancellationToken,
  ): Promise<Timeline | undefined> {
    const absPath = fileURLToPath(uri)
    const client = this._mgr.resolveContaining(absPath)
    if (!client) return undefined
    const limit = options.limit ?? 50

    let depotFile: string | undefined
    let fromRev: number | undefined
    if (options.cursor !== undefined) {
      const cursor = parseCursor(options.cursor)
      if (!cursor) return undefined
      depotFile = cursor.depotFile
      fromRev = cursor.rev
    }

    const items: TimelineItem[] = []
    if (options.cursor === undefined) {
      const info = await client.fstat(absPath)
      // No depot file → not under Perforce control; stay silent for the file.
      if (!info) return undefined
      depotFile = info.depotFile
      const pending = await this._pendingItem(client, absPath, info)
      if (pending) items.push(pending)
    }
    if (!depotFile) return undefined

    const revisions = await client.getFilelog(depotFile, limit + 1, fromRev)
    const hasMore = revisions.length > limit
    const probe = hasMore ? revisions[limit] : undefined
    for (const revision of revisions.slice(0, limit)) {
      items.push(revisionItem(revision, absPath, depotFile))
    }
    return { items, ...(probe !== undefined ? { cursor: `${depotFile}#${probe.rev}` } : {}) }
  }

  /** The "Pending Changes" entry, when the working tree diverges from #have. */
  private async _pendingItem(
    client: PerforceClient,
    absPath: string,
    info: { depotFile: string; haveRev: string | undefined; action: string | undefined },
  ): Promise<TimelineItem | undefined> {
    const cfg = workspace.getConfiguration('perforce')
    if ((await cfg.get('timeline.showPending', true)) === false) return undefined

    // Open files are pending by definition; an unopened file needs a content
    // compare against the have revision (the reconcile-drift case, matching
    // git's uncommitted check).
    const diverged = info.action !== undefined || (await client.differsFromHave(absPath))
    if (!diverged) return undefined

    const st = await stat(absPath).catch(() => undefined)
    const timestamp = st?.mtimeMs ?? Date.now()
    return {
      label: localize('perforce.timeline.pendingChanges', 'Pending Changes'),
      ...(st !== undefined ? { description: relativeTimeAgo(st.mtimeMs) } : {}),
      timestamp,
      contextValue: 'perforce:file:working',
      command: {
        command: 'perforce.timeline.openDiff',
        title: localize('perforce.timeline.openComparison', 'Open Comparison'),
        arguments: [
          { uri: absPath, depotFile: info.depotFile, haveRev: info.haveRev, pending: true },
        ],
      },
    }
  }
}

function revisionItem(revision: FilelogRevision, absPath: string, depotFile: string): TimelineItem {
  const timestamp = revision.time * 1000
  return {
    id: revision.change,
    label: filelogLabel(revision),
    description: relativeTimeAgo(timestamp),
    tooltip: `changelist ${revision.change}\n${revision.user}@${revision.client}\n${new Date(timestamp).toLocaleString()}\n\n${revision.desc}`,
    timestamp,
    themeIcon: 'git-commit',
    contextValue: 'perforce:file:rev',
    command: {
      command: 'perforce.timeline.openDiff',
      title: localize('perforce.timeline.openComparison', 'Open Comparison'),
      arguments: [
        {
          uri: absPath,
          depotFile,
          rev: revision.rev,
          action: revision.action,
          change: revision.change,
        },
      ],
    },
  }
}

/** The timeline feature's commands (item click + context menu entries). */
export function createPerforceTimelineCommands(
  mgr: ClientManager,
  log?: (msg: string) => void,
): Disposable[] {
  return [
    commands.registerCommand('perforce.timeline.openDiff', async (arg: unknown) => {
      const { uri, depotFile, rev, action, change, haveRev, pending } = (arg ?? {}) as OpenDiffArg
      if (!uri || !depotFile) return
      const client = mgr.resolveContaining(uri)
      if (!client) return

      let original = ''
      let modified = ''
      let title: string
      let live = false
      if (pending) {
        // Left = the have revision (an open-for-add file has none → empty);
        // right = the working tree, tracked live. A deleted working copy just
        // reads as empty, rendering the row as a deletion.
        if (haveRev) original = await client.printRevision(`${depotFile}#${haveRev}`)
        try {
          modified = await readFile(uri, 'utf8')
        } catch {
          modified = ''
        }
        title = `${basename(uri)} (Working Tree)`
        live = true
      } else {
        if (!rev) return
        const { left, right } = fileDiffRevs(depotFile, statusFromAction(action ?? ''), rev)
        ;[original, modified] = await Promise.all([
          client.printRevision(left),
          client.printRevision(right),
        ])
        title = `${basename(displayPath(depotFile))} (changelist ${change ?? rev})`
      }

      const fileUrl = pathToFileURL(uri).href
      await commands.executeCommand('_workbench.openDiff', {
        title,
        originalUri: fileUrl,
        original,
        modified,
        pinned: false,
        preserveFocus: false,
        openableUri: fileUrl,
        // The pending entry's right side is the working tree — it tracks live
        // edits; a submitted revision is frozen and must not be live-synced.
        ...(live && { liveModified: true }),
      })
      log?.(
        `[perforce] timeline openDiff ${depotFile}${rev ? `#${rev}` : ''} (pending=${!!pending})`,
      )
    }),

    commands.registerCommand('perforce.timeline.copyChangelistNumber', (item: unknown) => {
      const id = (item as { id?: string } | undefined)?.id
      if (id) return commands.executeCommand('_workbench.writeClipboard', id)
      return undefined
    }),
  ]
}
