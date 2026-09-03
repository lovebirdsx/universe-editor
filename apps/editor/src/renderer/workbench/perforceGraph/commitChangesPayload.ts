import type {
  P4GraphChangeDetailsDto,
  ShowCommitChangesPayload,
} from '@universe-editor/extensions-common'
import { localize } from '@universe-editor/platform'
import { scmProviderPathKey } from '../../services/extensions/ScmService.js'
import type { GraphScopePath } from '../../services/perforceGraph/graphScopeSelection.js'

const OPEN_FILE_DIFF_COMMAND = 'perforce-graph.openFileDiff'

/** A scope path with its comparison key precomputed. */
interface ScopeKey {
  key: string
  isDirectory: boolean
}

/**
 * Does this changelist file fall inside one of the scoped paths? Keys go through
 * `scmProviderPathKey` — the same comparison `openScopedFileDiff` already uses,
 * and case-insensitive on purpose: the two sides are not the same source (the
 * scope comes from the user's Explorer selection, `localPath` from `p4 where`),
 * so on Windows they can differ only in case and still be the same file. The
 * cost is that on a case-sensitive host two files differing only in case would
 * both match — showing one extra row, never hiding one.
 */
function hitsScope(localPath: string | null, scopes: readonly ScopeKey[]): boolean {
  if (localPath === null) return false
  const key = scmProviderPathKey(localPath)
  return scopes.some((s) => (s.isDirectory ? key.startsWith(`${s.key}/`) : key === s.key))
}

export interface BuildChangePayloadOptions {
  /**
   * The merged-history tab's selection. Narrows the file list to entries under
   * these paths and notes how many of the changelist's files were left out. A
   * zero-hit changelist deliberately shows an **empty** list rather than falling
   * back to the whole changelist: the fallback would mask a real inconsistency
   * between the history listing and the file set. Omit it and nothing changes —
   * single-path and whole-graph tabs still show the entire changelist.
   */
  scopePaths?: readonly GraphScopePath[]
  /** Client the listing was read from; carried into each row's diff request. */
  clientRoot?: string
}

/** Build the Commit Changes payload for one submitted changelist. */
export function buildChangePayload(
  details: P4GraphChangeDetailsDto,
  options?: BuildChangePayloadOptions,
): ShowCommitChangesPayload {
  const subject = details.body.split('\n', 1)[0]?.trim() ?? ''
  const base = `Changelist ${details.id}`
  const clientRoot = options?.clientRoot
  const scopes = options?.scopePaths?.map(
    (s): ScopeKey => ({ key: scmProviderPathKey(s.path), isDirectory: s.isDirectory }),
  )
  const files = scopes ? details.files.filter((f) => hitsScope(f.localPath, scopes)) : details.files
  const hidden = details.files.length - files.length
  let subtitle = `${details.author} · ${new Date(details.date * 1000).toLocaleString()}`
  if (scopes && hidden > 0) {
    subtitle += localize(
      'perforceGraph.commitChanges.hiddenFiles',
      ' · {count} more file(s) in this changelist outside the selection',
      { count: hidden },
    )
  }
  return {
    providerId: 'perforce',
    title: subject ? `${base} — ${subject}` : base,
    subtitle,
    commitRef: String(details.id),
    openExternalCommand: OPEN_FILE_DIFF_COMMAND,
    files: files.map((f) => ({
      path: f.path,
      oldPath: f.oldPath,
      status: f.status,
      resourcePath: f.localPath,
      args: {
        depotFile: f.depotFile,
        status: f.status,
        rev: f.rev,
        ...(f.localPath !== null ? { localPath: f.localPath } : {}),
        ...(clientRoot !== undefined ? { clientRoot } : {}),
      },
    })),
    metadata: { author: details.author, authorDate: details.date, message: details.body },
  }
}
