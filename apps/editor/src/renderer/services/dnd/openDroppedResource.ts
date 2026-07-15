/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Routes a resource dropped onto the editor area: folders open in a new window
 *  (one per folder), files open as editors. Pure of React/DOM so it can be unit
 *  tested with stub services.
 *--------------------------------------------------------------------------------------------*/

import {
  localize,
  NullLogger,
  Severity,
  type IEditorGroup,
  type IEditorGroupsService,
  type IEditorResolverService,
  type IFileService,
  type ILogger,
  type INotificationService,
  type IWindowsService,
  type URI,
} from '@universe-editor/platform'

export interface DroppedResourceDeps {
  readonly fileService: Pick<IFileService, 'stat'>
  readonly windowsService: Pick<IWindowsService, 'openWindow'>
  readonly editorResolverService: Pick<IEditorResolverService, 'openEditor'>
  /**
   * The group the resource was dropped onto. `openEditor` always targets the
   * active group (and dedupes "already open" against it), so a drop onto a
   * non-active group would otherwise open in the wrong place — or silently no-op
   * because the file is open in the active group. Activate the drop target first
   * so both the open and the dedup are scoped to it (VSCode parity).
   */
  readonly groupsService?: Pick<IEditorGroupsService, 'activateGroup'>
  readonly targetGroup?: IEditorGroup
  /** Surfaces a user-visible reason when a dropped resource can't be opened. */
  readonly notificationService?: Pick<INotificationService, 'notify'>
  /** Diagnostic log; defaults to a no-op logger. */
  readonly logger?: ILogger
}

/**
 * Open a single dropped resource. A folder can't be shown as an editor, so it
 * opens in a new window; anything else (or a URI that can't be statted) opens as
 * an editor in the drop-target group.
 *
 * Returns `true` when the open (window or editor) was dispatched, `false` when
 * it was skipped or failed — a user-visible notification explaining why is shown
 * in the latter case.
 */
export async function openDroppedResource(
  resource: URI,
  deps: DroppedResourceDeps,
): Promise<boolean> {
  const logger = deps.logger ?? new NullLogger()

  let isDirectory = false
  let statFailed = false
  try {
    isDirectory = (await deps.fileService.stat(resource)).isDirectory
  } catch (err) {
    // Non-fs URIs (or missing paths) can't be statted — treat as a file, but
    // remember the failure so a follow-up open error can explain it precisely.
    statFailed = true
    logger.debug(`openDroppedResource stat failed uri=${resource.toString()} err=${String(err)}`)
  }

  if (isDirectory) {
    try {
      await deps.windowsService.openWindow(resource)
      logger.info(`openDroppedResource opened folder in new window uri=${resource.toString()}`)
      return true
    } catch (err) {
      logger.error(
        `openDroppedResource openWindow failed uri=${resource.toString()} err=${String(err)}`,
      )
      notifyFailure(
        deps,
        localize('dnd.open.folderFailed', 'Could not open the folder "{name}" in a new window.', {
          name: basename(resource),
        }),
      )
      return false
    }
  }

  if (deps.targetGroup && deps.groupsService) {
    deps.groupsService.activateGroup(deps.targetGroup)
  }
  try {
    await deps.editorResolverService.openEditor(resource)
    logger.info(`openDroppedResource opened editor uri=${resource.toString()}`)
    return true
  } catch (err) {
    logger.error(
      `openDroppedResource openEditor failed uri=${resource.toString()} err=${String(err)}`,
    )
    notifyFailure(
      deps,
      statFailed
        ? localize(
            'dnd.open.fileMissing',
            'Could not open "{name}". The file may have been moved, deleted, or is not accessible.',
            { name: basename(resource) },
          )
        : localize('dnd.open.fileFailed', 'Could not open "{name}".', {
            name: basename(resource),
          }),
    )
    return false
  }
}

function notifyFailure(deps: DroppedResourceDeps, message: string): void {
  deps.notificationService?.notify({ severity: Severity.Error, message })
}

function basename(resource: URI): string {
  const segments = resource.path.split('/').filter((s) => s.length > 0)
  return segments[segments.length - 1] ?? resource.toString()
}
