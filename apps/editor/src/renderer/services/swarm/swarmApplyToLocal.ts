/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  swarmApplyToLocal — shared "Apply to Local" flow used by the review detail
 *  editor's header button and the Reviews view's context menu: classify the
 *  version's files, confirm the scope (two persisted toggles), send the
 *  `perforce.swarm.applyToLocal` command and surface the four-tier outcome.
 *  Dependency-injected so both React call sites can pass their own services.
 *--------------------------------------------------------------------------------------------*/

import {
  Severity,
  URI,
  type ICommandService,
  type IConfirmCheckbox,
  type IConfirmResult,
  type IDialogService,
  type INotificationService,
  type IStorageService,
  type IUriIdentityService,
  type IWorkspaceService,
  localize,
} from '@universe-editor/platform'
import {
  SwarmCommands,
  type SwarmApplyToLocalRequest,
  type SwarmApplyToLocalResult,
  type SwarmReviewFileDto,
} from '@universe-editor/extensions-common'
import { normalizeSwarmStream, planApplyToLocal, type ApplyPlan } from './swarmApplyPlan.js'
import { swarmApplyStore } from './swarmApplyStore.js'

export interface SwarmApplyToLocalDeps {
  readonly commands: ICommandService
  readonly dialog: IDialogService
  readonly notifications: INotificationService
  readonly storage: IStorageService
  readonly uriIdentity: IUriIdentityService
  readonly workspaceService: IWorkspaceService
  /** Surface a host-side apply failure in the caller's own error slot. */
  readonly onError: (message: string) => void
}

export interface SwarmApplyToLocalInput {
  readonly reviewId: string
  /** Backing p4 change to unshelve — `archiveChange ?? change` of the target version. */
  readonly change: string
  /** That version's files (from describeVersion). */
  readonly files: readonly SwarmReviewFileDto[]
  /** The target version's stream (`//depot/...`, from `resolveReviewStream`).
   *  Only the forced cross-stream path needs it; without it unmapped files
   *  remain unapplyable and the old mismatch toast is shown. */
  readonly stream?: string
}

/** Join the first few skipped/unmapped paths for dialog/notification wording. */
function formatPathList(paths: readonly string[], max = 3): string {
  const head = paths.slice(0, max).join(', ')
  return paths.length > max ? `${head} and ${paths.length - max} more` : head
}

function buildToggles(includeOutside: boolean, intoChangelist: boolean): IConfirmCheckbox[] {
  return [
    {
      label: localize('swarm.apply.checkbox', 'Also replace files outside the workspace'),
      initiallyChecked: includeOutside,
    },
    {
      label: localize(
        'swarm.apply.checkbox.changelist',
        'Open applied files in the default changelist',
      ),
      initiallyChecked: intoChangelist,
    },
  ]
}

/** Wording shared by both dialog shapes: mapped scope, outside skips, and the
 *  usual "open/out-of-date files are skipped" note. */
function buildMappedDetail(plan: ApplyPlan): string[] {
  const parts = [
    localize(
      'swarm.apply.detail',
      'This replaces the local content of {0} file(s) with the review version.',
      { 0: String(plan.depotFiles.length) },
    ),
  ]
  if (plan.outsidePaths.length > 0) {
    parts.push(
      localize(
        'swarm.apply.detail.outside',
        '{0} file(s) outside the workspace will be skipped: {1}',
        { 0: String(plan.outsidePaths.length), 1: formatPathList(plan.outsidePaths) },
      ),
    )
  }
  return parts
}

/** The force-only dialog lists what the fallback can and cannot do, because the
 *  user is about to write across streams and the host may skip files. */
function buildForceDetail(plan: ApplyPlan, stream: string): string {
  return [
    localize(
      'swarm.apply.force.detail.stream',
      'This review targets {0}, which is not mapped in the current workspace.',
      { 0: stream },
    ),
    localize(
      'swarm.apply.force.detail.count',
      'Perforce will map {0} file(s) onto the corresponding paths of the current stream.',
      { 0: String(plan.unmappedFiles.length) },
    ),
    localize(
      'swarm.apply.force.detail.native',
      'It uses p4 stream mapping first and falls back to rewriting the stream prefix. Files that cannot be mapped are skipped and reported.',
    ),
    localize(
      'swarm.apply.force.detail.limits',
      'Deleted files are skipped by the fallback. Files outside the workspace stay skipped unless the checkbox below is checked.',
    ),
  ].join('\n')
}

/**
 * Apply a review version's files to the workspace via `p4 unshelve -f`
 * (host-side command). The immutable archive snapshot (change) is the source,
 * so a re-shelved author changelist can't drift what gets applied. `-f`
 * overwrites local copies — including unopened hand-edited files (the point of
 * the feature); files p4 refuses (already open, stale base) come back in
 * `skipped`.
 */
export async function applySwarmReviewToLocal(
  input: SwarmApplyToLocalInput,
  deps: SwarmApplyToLocalDeps,
): Promise<void> {
  const { reviewId, change, files } = input
  const stream = normalizeSwarmStream(input.stream)
  const { commands, dialog, notifications, storage, uriIdentity, workspaceService, onError } = deps
  if (!reviewId || !change || files.length === 0) return
  await swarmApplyStore.attach(storage)
  const includeOutside = swarmApplyStore.includeOutside
  const intoChangelist = swarmApplyStore.intoChangelist
  const folder = workspaceService.current?.folder
  const isInWorkspace = (fsPath: string) =>
    folder !== undefined && uriIdentity.isEqualOrParent(URI.file(fsPath), folder)
  const plan = planApplyToLocal(files, includeOutside, isInWorkspace)
  const hasMapped = plan.mappedFiles.length > 0
  const canForce = stream !== undefined && plan.unmappedFiles.length > 0
  if (!hasMapped && !canForce) {
    // Nothing p4 could restore: every file is unmapped (not in the client
    // view — the review targets another stream/branch) or mapped outside the
    // workspace with the toggle off. The unmapped case gets its own wording
    // since no checkbox can fix it — and without a stream there is nothing to
    // map it onto either.
    const unmappedOnly = plan.unmappedPaths.length > 0 && plan.outsidePaths.length === 0
    const message = unmappedOnly
      ? localize(
          'swarm.apply.nothing.mismatch',
          'Cannot apply this review: its files belong to a different stream/branch than the current workspace.',
        )
      : localize(
          'swarm.apply.nothing',
          'Nothing to apply: no mapped file of this version is inside the workspace.',
        )
    notifications.notify({ severity: Severity.Info, message, sticky: true })
    return
  }
  const toggles = buildToggles(includeOutside, intoChangelist)
  let res: IConfirmResult
  if (!hasMapped) {
    // Every file is unmapped but the review's stream is known: offer the
    // forced cross-stream path. Cancel is the default so a stray Enter cannot
    // overwrite files in another stream's layout.
    if (stream === undefined) return
    res = await dialog.confirm({
      type: 'warning',
      message: localize(
        'swarm.apply.force.confirm',
        'Force apply review #{0} to the current stream?',
        { 0: reviewId },
      ),
      detail: buildForceDetail(plan, stream),
      buttons: [localize('swarm.apply.force', 'Force Apply')],
      dismissButton: localize('swarm.apply.cancel', 'Cancel'),
      defaultButton: 'dismiss',
      checkboxes: toggles,
    })
    if (!res.confirmed) return
  } else {
    const detailParts = buildMappedDetail(plan)
    if (plan.unmappedPaths.length > 0) {
      detailParts.push(
        canForce
          ? localize(
              'swarm.apply.detail.unmappedForce',
              '{0} file(s) belong to a different stream/branch. Choose "Force Apply" to map them onto the current stream.',
              { 0: String(plan.unmappedPaths.length) },
            )
          : localize(
              'swarm.apply.detail.unmapped',
              '{0} file(s) belong to a different stream/branch and cannot be applied.',
              { 0: String(plan.unmappedPaths.length) },
            ),
      )
    }
    detailParts.push(
      localize(
        'swarm.apply.detail.skippedNote',
        'Files already open or out of date will be skipped and reported.',
      ),
    )
    res = await dialog.confirm({
      type: 'warning',
      message: localize('swarm.apply.confirm', 'Apply review #{0} to local files?', {
        0: reviewId,
      }),
      detail: detailParts.join('\n'),
      primaryButton: localize('swarm.applyToLocal', 'Apply to Local'),
      ...(canForce ? { secondaryButton: localize('swarm.apply.force', 'Force Apply') } : {}),
      checkboxes: toggles,
    })
    if (!res.confirmed && res.choice !== 'secondary') return
  }
  const useForce = !hasMapped || res.choice === 'secondary'
  // The checkboxes can change which files are in scope and how they land —
  // re-plan with the final values before persisting/sending.
  const outsideChecked = res.checkboxChecked?.[0] ?? includeOutside
  const changelistChecked = res.checkboxChecked?.[1] ?? intoChangelist
  const finalPlan = planApplyToLocal(files, outsideChecked, isInWorkspace)
  swarmApplyStore.setIncludeOutside(outsideChecked)
  swarmApplyStore.setIntoChangelist(changelistChecked)
  const finalFiles = useForce ? finalPlan.forceFiles : finalPlan.mappedFiles
  if (finalFiles.length === 0) {
    notifications.notify({
      severity: Severity.Info,
      message: localize('swarm.apply.nothingApplied', 'No files were applied.'),
    })
    return
  }
  try {
    const request: SwarmApplyToLocalRequest = {
      change,
      files: finalFiles.map((file) => ({ depotFile: file.depotFile, status: file.status })),
      intoChangelist: changelistChecked,
      ...(useForce && stream !== undefined
        ? {
            force: true,
            stream,
            includeOutside: outsideChecked,
            ...(folder !== undefined ? { workspaceRoot: folder.fsPath } : {}),
          }
        : {}),
    }
    const result = await commands.executeCommand<SwarmApplyToLocalResult>(
      SwarmCommands.applyToLocal,
      request,
    )
    const applied = result?.applied.length ?? 0
    const skipped = result?.skipped ?? []
    const keptOpen = result?.keptOpen ?? []
    if (applied === 0 && skipped.length === 0) {
      notifications.notify({
        severity: Severity.Info,
        message: localize('swarm.apply.nothingApplied', 'No files were applied.'),
      })
    } else if (skipped.length === 0) {
      notifications.notify({
        severity: Severity.Info,
        message: changelistChecked
          ? localize('swarm.apply.done', 'Applied {0} file(s) to the workspace.', {
              0: String(applied),
            })
          : localize(
              'swarm.apply.done.noChangelist',
              'Applied {0} file(s) to the workspace (not opened in a changelist).',
              { 0: String(applied) },
            ),
      })
    } else {
      // INotification has no detail field — the first few skipped entries go
      // into the message; the host-side logger.warn carries the full list.
      const preview = skipped
        .slice(0, 3)
        .map((s) => `${s.depotFile} — ${s.reason}`)
        .join('\n')
      notifications.notify({
        severity: Severity.Warning,
        message: localize(
          'swarm.apply.doneWithSkipped',
          'Applied {0} file(s); {1} skipped:\n{2}{3}',
          {
            0: String(applied),
            1: String(skipped.length),
            2: preview,
            3: skipped.length > 3 ? `\n…and ${skipped.length - 3} more` : '',
          },
        ),
      })
    }
    if (keptOpen.length > 0) {
      const keptPreview = keptOpen
        .slice(0, 3)
        .map((s) => `${s.depotFile} — ${s.reason}`)
        .join('\n')
      notifications.notify({
        severity: Severity.Warning,
        message: localize(
          'swarm.apply.keptOpen',
          '{0} file(s) could not be removed from the default changelist and remain open:\n{1}{2}',
          {
            0: String(keptOpen.length),
            1: keptPreview,
            2: keptOpen.length > 3 ? `\n…and ${keptOpen.length - 3} more` : '',
          },
        ),
      })
    }
  } catch (e: unknown) {
    onError(e instanceof Error ? e.message : String(e))
  }
}
