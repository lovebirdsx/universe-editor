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
import { planApplyToLocal } from './swarmApplyPlan.js'
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
}

/** Join the first few skipped/unmapped paths for dialog/notification wording. */
function formatPathList(paths: readonly string[], max = 3): string {
  const head = paths.slice(0, max).join(', ')
  return paths.length > max ? `${head} and ${paths.length - max} more` : head
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
  const { commands, dialog, notifications, storage, uriIdentity, workspaceService, onError } = deps
  if (!reviewId || !change || files.length === 0) return
  await swarmApplyStore.attach(storage)
  const includeOutside = swarmApplyStore.includeOutside
  const intoChangelist = swarmApplyStore.intoChangelist
  const folder = workspaceService.current?.folder
  const plan = planApplyToLocal(files, includeOutside, (fsPath) => {
    return folder !== undefined && uriIdentity.isEqualOrParent(URI.file(fsPath), folder)
  })
  if (plan.depotFiles.length === 0) {
    // Nothing p4 could restore: every file is unmapped (not in the client
    // view — the review targets another stream/branch) or mapped outside the
    // workspace with the toggle off. The unmapped case gets its own wording
    // since no checkbox can fix it.
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
  const detailParts: string[] = [
    localize(
      'swarm.apply.detail',
      'This replaces the local content of {0} file(s) with the review version.',
      { 0: String(plan.depotFiles.length) },
    ),
  ]
  if (plan.outsidePaths.length > 0) {
    detailParts.push(
      localize(
        'swarm.apply.detail.outside',
        '{0} file(s) outside the workspace will be skipped: {1}',
        {
          0: String(plan.outsidePaths.length),
          1: formatPathList(plan.outsidePaths),
        },
      ),
    )
  }
  if (plan.unmappedPaths.length > 0) {
    detailParts.push(
      localize(
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
  const res = await dialog.confirm({
    type: 'warning',
    message: localize('swarm.apply.confirm', 'Apply review #{0} to local files?', {
      0: reviewId,
    }),
    detail: detailParts.join('\n'),
    primaryButton: localize('swarm.applyToLocal', 'Apply to Local'),
    checkboxes: [
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
    ],
  })
  if (!res.confirmed) return
  // The checkboxes can change which files are in scope and how they land —
  // re-plan with the final values before persisting/sending.
  const outsideChecked = res.checkboxChecked?.[0] ?? includeOutside
  const changelistChecked = res.checkboxChecked?.[1] ?? intoChangelist
  const finalPlan = planApplyToLocal(files, outsideChecked, (fsPath) => {
    return folder !== undefined && uriIdentity.isEqualOrParent(URI.file(fsPath), folder)
  })
  swarmApplyStore.setIncludeOutside(outsideChecked)
  swarmApplyStore.setIntoChangelist(changelistChecked)
  if (finalPlan.depotFiles.length === 0) {
    notifications.notify({
      severity: Severity.Info,
      message: localize('swarm.apply.nothingApplied', 'No files were applied.'),
    })
    return
  }
  try {
    const result = await commands.executeCommand<SwarmApplyToLocalResult>(
      SwarmCommands.applyToLocal,
      {
        change,
        depotFiles: finalPlan.depotFiles,
        intoChangelist: changelistChecked,
      } satisfies SwarmApplyToLocalRequest,
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
