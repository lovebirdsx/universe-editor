/** "Open Commit" support for the perforce extension: builds the commit-changes
 *  payload for one submitted changelist and hands it to the renderer's
 *  `_workbench.showCommitChanges` bridge. Shared by `perforce.viewCommit`
 *  (blame / command palette, registered in extension.ts) and
 *  `perforce.timeline.viewCommit` (timeline item context menu). The payload/result
 *  shapes mirror packages/extensions-common/src/contracts/commitChanges.ts
 *  — copied locally per the extension's convention (it must not bundle
 *  extensions-common).
 */
import { basename } from 'node:path'
import { pathToFileURL } from 'node:url'
import { commands } from '@universe-editor/extension-api'
import { descriptionFirstLine } from './changelist.js'
import { displayPath, fileDiffRevs, statusFromAction } from './p4GraphParser.js'
import { uriToFsPath } from './pathUtil.js'
import type { PerforceClient } from './client.js'
import type { ClientManager } from './clientManager.js'

interface CommitChangesFileEntry {
  readonly path: string
  readonly oldPath: string | null
  readonly status: string
  readonly resourceUri: string | null
  readonly args: unknown
}

export interface CommitChangesMetadata {
  readonly author?: string
  /** Unix seconds. */
  readonly authorDate?: number
  readonly message?: string
  readonly parents?: string[]
  readonly compareRefs?: { from: string; to: string }
}

export interface ShowCommitChangesPayload {
  readonly providerId: string
  readonly title: string
  readonly subtitle?: string
  readonly commitRef: string
  readonly openExternalCommand: string
  readonly files: CommitChangesFileEntry[]
  readonly revealPath?: string
  readonly metadata?: CommitChangesMetadata
}

/** Argument of `perforce-graph.openFileDiff` (structural mirror of the
 *  P4GraphFileDiffRequest contract). */
export interface P4GraphFileDiffRequest {
  readonly depotFile: string
  readonly status: string
  readonly rev: string
  readonly localPath?: string | null
}

/**
 * Normalize the uri argument `perforce.viewCommit` may receive (a file-URI
 * string, an fsPath, or a host Uri shape whose fsPath getter is lost over RPC)
 * and resolve the owning client, falling back to the graph's current client
 * (the blame route doesn't always know which client the line belongs to).
 */
function resolveClientForUri(
  mgr: ClientManager,
  uri: unknown,
  fallback: PerforceClient | undefined,
): PerforceClient | undefined {
  let path: string | undefined
  if (typeof uri === 'string') {
    path = uri.startsWith('file:')
      ? uriToFsPath({ scheme: 'file', path: new URL(uri).pathname })
      : uri
  } else if (uri && typeof uri === 'object') {
    path = uriToFsPath(uri as { scheme?: string; path?: string })
  }
  return (path ? mgr.resolveContaining(path) : undefined) ?? fallback
}

/** Build the commit-changes payload for one submitted changelist, or null when
 *  the change can't be described (missing id / p4 failure). */
export async function buildCommitChangesPayload(
  target: PerforceClient,
  changeId: string,
  log?: (msg: string) => void,
): Promise<ShowCommitChangesPayload | null> {
  const detail = await target.getGraphChangeDetails(changeId)
  if (!detail) {
    log?.(`[perforce] viewCommit: no details for changelist ${changeId}`)
    return null
  }
  const files: CommitChangesFileEntry[] = detail.files.map((f) => {
    const localPath = detail.localPaths.get(f.depotFile) ?? null
    const status = statusFromAction(f.action)
    return {
      path: displayPath(f.depotFile),
      oldPath: null,
      status,
      resourceUri: localPath ? pathToFileURL(localPath).href : null,
      args: { depotFile: f.depotFile, status, rev: f.rev, localPath },
    }
  })
  const subject = descriptionFirstLine(detail.body)
  const base = `Changelist ${detail.id}`
  return {
    providerId: 'perforce',
    title: subject ? `${base} — ${subject}` : base,
    subtitle: `${detail.author} · ${new Date(detail.date * 1000).toLocaleString()}`,
    commitRef: String(detail.id),
    openExternalCommand: 'perforce-graph.openFileDiff',
    files,
    metadata: { author: detail.author, authorDate: detail.date, message: detail.body },
  }
}

/**
 * `perforce.viewCommit` handler: open the whole changelist's changes in the
 * commit-changes view. Missing change id / unresolvable client logs and no-ops.
 */
export async function viewCommit(
  mgr: ClientManager,
  graphClient: () => PerforceClient | undefined,
  uri: unknown,
  changeId: unknown,
  log?: (msg: string) => void,
): Promise<void> {
  const id = typeof changeId === 'string' || typeof changeId === 'number' ? String(changeId) : ''
  if (!id) {
    log?.('[perforce] viewCommit: no changelist id, ignoring')
    return
  }
  const target = resolveClientForUri(mgr, uri, graphClient())
  if (!target) {
    log?.(`[perforce] viewCommit: no client for changelist ${id}, ignoring`)
    return
  }
  const payload = await buildCommitChangesPayload(target, id, log)
  if (!payload) return
  // The uri that located the client is the blamed/timeline file — when it's
  // part of this changelist, have the view scroll to its entry.
  const revealPath = revealPathForFile(payload, uri)
  log?.(`[perforce] viewCommit changelist ${id}: ${payload.files.length} files`)
  await commands.executeCommand('_workbench.showCommitChanges', {
    ...payload,
    ...(revealPath !== undefined ? { revealPath } : {}),
  })
}

/**
 * Match a caller-supplied file uri against the payload's entries (entries carry
 * `pathToFileURL(localPath).href`); returns the entry's `path` or undefined
 * when the file isn't in the changelist.
 */
export function revealPathForFile(
  payload: ShowCommitChangesPayload,
  fileUri: unknown,
): string | undefined {
  let path: string | undefined
  if (typeof fileUri === 'string') {
    path = fileUri.startsWith('file:')
      ? uriToFsPath({ scheme: 'file', path: new URL(fileUri).pathname })
      : fileUri
  } else if (fileUri && typeof fileUri === 'object') {
    path = uriToFsPath(fileUri as { scheme?: string; path?: string })
  }
  if (!path) return undefined
  const href = pathToFileURL(path).href
  return payload.files.find((entry) => entry.resourceUri === href)?.path
}

/**
 * `perforce-graph.openFileDiff` handler: print both revisions of one file and
 * open them in the renderer's diff editor. `options.preserveFocus` previews
 * the diff without stealing focus (Space-preview from the commit-changes
 * view), mirroring the git extension's `git-graph.openFileDiff`.
 */
export async function openGraphFileDiff(
  target: PerforceClient,
  req: P4GraphFileDiffRequest,
  options?: { preserveFocus?: boolean },
): Promise<void> {
  const { left, right } = fileDiffRevs(req.depotFile, req.status, req.rev)
  const [original, modified] = await Promise.all([
    target.printRevision(left),
    target.printRevision(right),
  ])
  const leftLabel = left ? left.slice(left.indexOf('#')) : '∅'
  const rightLabel = right ? right.slice(right.indexOf('#')) : '∅'
  await commands.executeCommand('_workbench.openDiff', {
    title: `${basename(displayPath(req.depotFile))} (${leftLabel} ↔ ${rightLabel})`,
    originalUri: pathToFileURL(displayPath(req.depotFile)).href,
    original,
    modified,
    pinned: false,
    preserveFocus: options?.preserveFocus ?? false,
    ...(req.localPath ? { openableUri: pathToFileURL(req.localPath).href } : {}),
  })
}
