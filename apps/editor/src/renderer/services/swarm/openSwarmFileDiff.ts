/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  openSwarmFileDiff — the one way to open a Swarm review file's diff, shared by
 *  the review detail editor and the Swarm Changes sidebar view. It owns the
 *  spreadsheet routing (byte probe → Excel webview / oversized CSV → Monaco text
 *  / oversized binary → notification), the immutable-both-sides tab reuse keyed on
 *  swarmDiffEditorId, and the perf phases. Callers only resolve WHICH two
 *  snapshots to compare; everything downstream of that decision lives here so the
 *  two entry points can never drift on tab identity or caching semantics.
 *--------------------------------------------------------------------------------------------*/

import {
  Severity,
  URI,
  localize,
  type ICommandService,
  type IEditorService,
  type IInstantiationService,
  type ILogger,
  type INotificationService,
} from '@universe-editor/platform'
import {
  SwarmCommands,
  type SwarmFileContentRequest,
  type SwarmFileContentResult,
  type SwarmReviewFileDto,
} from '@universe-editor/extensions-common'
import {
  SwarmDiffEditorInput,
  swarmDiffEditorId,
  type SwarmDiffContext,
} from '../editor/SwarmDiffEditorInput.js'
import { recordPerfPhase, recordPerfPhaseAsync } from '../performance/perfPhases.js'
import type { OpenWebviewDiffPayload } from '../../actions/diffActions.js'

/** Custom-editor viewType of the bundled Excel viewer/diff (mirrors the local
 *  Perforce spreadsheet diff in the perforce extension's `client.ts`). */
const SPREADSHEET_VIEW_TYPE = 'universe.excel'
const SPREADSHEET_EXTS = ['.xlsx', '.xls', '.xlsm', '.csv']

/**
 * Upper bound (decoded bytes, larger side) for routing a spreadsheet into the
 * Excel webview diff. The viewer diffs with a whole-table LCS (O(rows²) dp
 * matrix) and renders every cell unvirtualized — on a multi-MB table that OOMs
 * the extension host (the panel then stays blank) and freezes the renderer for
 * ~10s on base64 re-encoding alone. Past the cap, a CSV falls back to the
 * Monaco text diff (it's plain text); binary workbooks get a notification.
 */
export const SPREADSHEET_DIFF_MAX_BYTES = 1024 * 1024

/** True when a path is a spreadsheet the Excel viewer should diff in a webview. */
export function isSpreadsheetPath(path: string): boolean {
  const lower = path.toLowerCase()
  return SPREADSHEET_EXTS.some((ext) => lower.endsWith(ext))
}

/** Decoded byte size of a base64 string (¾ of its length, ignoring padding). */
function base64DecodedBytes(base64: string): number {
  return Math.floor(base64.length * 0.75)
}

/** Decode a base64 payload as UTF-8 text (no spread — a multi-MB payload would
 *  blow the call stack, see diffActions' decoder). */
function decodeBase64Utf8(base64: string): string {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return new TextDecoder().decode(bytes)
}

export interface OpenSwarmFileDiffRequest {
  readonly reviewId: string
  readonly file: SwarmReviewFileDto
  /** Right side's backing p4 change (`archiveChange ?? change`); null = absent. */
  readonly rightChange: string | null
  /** Right side REV number for display + comment anchoring; null = absent. */
  readonly rightRev: number | null
  /** Left side's backing p4 change; null = the depot base. */
  readonly leftChange: string | null
  /** Left side REV number; 0 = the depot base. */
  readonly leftVersion: number
  /** True when the right side is an immutable archive shelf. */
  readonly rightImmutable: boolean
  /** True when the left side is an immutable archive shelf. */
  readonly leftImmutable: boolean
  /** Light open into the preview slot without stealing focus (single click /
   *  Space). Defaults to a pinned, focus-taking open. */
  readonly preview?: boolean
}

export interface OpenSwarmFileDiffDeps {
  readonly commands: ICommandService
  readonly editorService: IEditorService
  readonly inst: IInstantiationService
  readonly logger: ILogger
  readonly notifications: INotificationService
  /** Surface a fetch/print failure in the caller's own error slot. */
  readonly onError: (message: string) => void
}

/**
 * Open a file's diff between the two given snapshots. Both sides are p4
 * snapshots at their version's backing change, so line numbers stay aligned with
 * Swarm's inline-comment coordinates.
 */
export async function openSwarmFileDiff(
  request: OpenSwarmFileDiffRequest,
  deps: OpenSwarmFileDiffDeps,
): Promise<void> {
  const { commands, editorService, inst, logger, notifications, onError } = deps
  const {
    reviewId,
    file,
    rightChange,
    rightRev,
    leftChange,
    leftVersion,
    preview = false,
  } = request

  const added = file.status.charAt(0) === 'A'
  const deleted = file.status.charAt(0) === 'D'
  const originalRevision =
    leftChange === null ? (file.baseRevision ? `#${file.baseRevision}` : null) : `@=${leftChange}`
  const modifiedRevision = rightChange ? `@=${rightChange}` : null
  // `#<rev>` sides need no flag — the client caches concrete revisions
  // unconditionally; the flag matters for `@=<change>` archive shelves.
  const originalImmutable = leftChange !== null && request.leftImmutable
  const modifiedImmutable = rightChange !== null && request.rightImmutable

  const openOptions = preview ? { pinned: false, preserveFocus: true } : { pinned: true }

  // Spreadsheets can't be shown in a Monaco text diff — utf8-decoding the zip
  // bytes yields garbage and the diff looks empty. Route them to the Excel
  // webview over the two revisions' raw bytes (base64), mirroring the local
  // Perforce spreadsheet diff (client.ts `_openSpreadsheetChange`). We match by
  // extension + hardcode the viewType exactly as the local path does, rather
  // than gating on the editor resolver's `supportsDiff` — the custom editor
  // registers asynchronously and an older Excel extension may not declare the
  // flag, either of which would silently drop us back to the empty text diff.
  let spreadsheetText: { original: string; modified: string } | undefined
  if (isSpreadsheetPath(file.path)) {
    try {
      const getBytes = async (
        revision: string | null,
        immutable: boolean,
      ): Promise<SwarmFileContentResult> => {
        if (!revision) return { content: '' }
        return (
          (await commands.executeCommand<SwarmFileContentResult>(
            SwarmCommands.getFileContentBytes,
            {
              depotFile: file.depotFile,
              revision,
              ...(immutable ? { immutable: true } : {}),
            } satisfies SwarmFileContentRequest,
          )) ?? { content: '' }
        )
      }
      const [left, right] = await Promise.all([
        getBytes(added ? null : originalRevision, originalImmutable),
        getBytes(deleted ? null : modifiedRevision, modifiedImmutable),
      ])
      // A failed print comes back as empty bytes — never let it reach the
      // size-based routing below, where 0 bytes would read as a tiny file.
      const fetchError = left.error ?? right.error
      if (fetchError !== undefined) {
        logger.debug(`openFileDiff ${file.path}: byte probe failed, route=error (${fetchError})`)
        onError(fetchError)
        return
      }
      const largestSide = Math.max(
        base64DecodedBytes(left.content),
        base64DecodedBytes(right.content),
      )
      if (largestSide <= SPREADSHEET_DIFF_MAX_BYTES) {
        // info, not debug: the size-based routing decision is the first thing to
        // check when a diff opens in the wrong editor kind (e.g. a truncated p4
        // print flipping a >1MB csv back under the cap) — it must be in the log
        // file at the default level.
        logger.info(
          `openFileDiff ${file.path}: largestSide=${largestSide} cap=${SPREADSHEET_DIFF_MAX_BYTES}, route=webview`,
        )
        // Distinct left/right URIs carrying the backing-change pair keep the
        // diff tab's identity unique per comparison (WebviewDiffInput ids by
        // both URIs) — pending versions share a rev, so only the change
        // distinguishes them. The .xlsx path drives the tab icon. See memory
        // editor-input-identity-isolation.
        const sideUri = (side: 'l' | 'r', change: string | null): string =>
          URI.from({
            scheme: 'swarm',
            path: `/${reviewId}/${file.path}`,
            query: `${side}=${change ?? ''}`,
          }).toString()
        await commands.executeCommand('_workbench.openWebviewDiff', {
          viewType: SPREADSHEET_VIEW_TYPE,
          title: `${file.path.split('/').pop() ?? file.path} (Swarm)`,
          leftUri: sideUri('l', added ? null : leftChange),
          rightUri: sideUri('r', deleted ? null : rightChange),
          leftBase64: left.content,
          rightBase64: right.content,
          pinned: false,
          preserveFocus: preview,
        } satisfies OpenWebviewDiffPayload)
        return
      }
      if (!file.path.toLowerCase().endsWith('.csv')) {
        // A binary workbook past the cap has no readable fallback.
        logger.info(
          `openFileDiff ${file.path}: largestSide=${largestSide} cap=${SPREADSHEET_DIFF_MAX_BYTES}, route=too-large`,
        )
        notifications.notify({
          severity: Severity.Warning,
          message: localize(
            'swarm.diff.spreadsheetTooLarge',
            'This spreadsheet is too large to compare as a table ({0} MB).',
            { 0: (largestSide / (1024 * 1024)).toFixed(1) },
          ),
        })
        return
      }
      // Oversized CSV: decode the bytes already probed above and diff them as
      // text below — re-printing both sides via getFileContent would double
      // the p4 traffic for the largest files we handle.
      logger.info(
        `openFileDiff ${file.path}: largestSide=${largestSide} cap=${SPREADSHEET_DIFF_MAX_BYTES}, route=monaco-text`,
      )
      spreadsheetText = {
        original: added ? '' : decodeBase64Utf8(left.content),
        modified: deleted ? '' : decodeBase64Utf8(right.content),
      }
    } catch (e: unknown) {
      onError(e instanceof Error ? e.message : String(e))
      return
    }
  }

  const context: SwarmDiffContext = {
    reviewId,
    depotFile: file.depotFile,
    displayPath: file.path,
    localPath: file.localPath,
    leftVersion: added ? null : leftVersion,
    rightVersion: deleted ? null : rightRev,
    leftChange: added ? null : leftChange,
    rightChange: deleted ? null : rightChange,
  }
  // Both sides immutable (archive shelves / depot base / absent) → the diff
  // can never change, so a reopen of an already-open tab skips the p4 fetch
  // entirely. A pending (re-shelvable) side keeps the refetch-and-refresh
  // semantics. openEditors mirrors the active group — the same scope
  // EditorService.openEditor dedupes in.
  const bothImmutable =
    (added || leftChange === null || originalImmutable) && (deleted || modifiedImmutable)
  if (bothImmutable) {
    const existing = editorService.openEditors
      .get()
      .find((e) => e.id === swarmDiffEditorId(context))
    if (existing) {
      recordPerfPhase('swarm.openFileDiff.reuse', () => {})
      editorService.openEditor(existing, openOptions)
      return
    }
  }
  const getContent = async (
    revision: string | null,
    immutable: boolean,
  ): Promise<SwarmFileContentResult> => {
    if (!revision) return { content: '' }
    return recordPerfPhaseAsync(
      'swarm.openFileDiff.fetchSide',
      async () =>
        (await commands.executeCommand<SwarmFileContentResult>(SwarmCommands.getFileContent, {
          depotFile: file.depotFile,
          revision,
          ...(immutable ? { immutable: true } : {}),
        } satisfies SwarmFileContentRequest)) ?? { content: '' },
    )
  }
  try {
    await recordPerfPhaseAsync('swarm.openFileDiff.total', async () => {
      let original: string
      let modified: string
      if (spreadsheetText) {
        ;({ original, modified } = spreadsheetText)
      } else {
        const [left, right] = await recordPerfPhaseAsync('swarm.openFileDiff.fetch', () =>
          Promise.all([
            getContent(added ? null : originalRevision, originalImmutable),
            getContent(deleted ? null : modifiedRevision, modifiedImmutable),
          ]),
        )
        const fetchError = left.error ?? right.error
        if (fetchError !== undefined) {
          logger.debug(`openFileDiff ${file.path}: fetch failed, route=error (${fetchError})`)
          onError(fetchError)
          return
        }
        original = left.content
        modified = right.content
      }
      await editorService.openEditor(
        inst.createInstance(SwarmDiffEditorInput, context, original, modified),
        openOptions,
      )
    })
  } catch (e: unknown) {
    onError(e instanceof Error ? e.message : String(e))
  }
}
