/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  `_workbench.showCommitChanges` — the internal bridge command extensions
 *  invoke to surface one commit's (or changelist's) changed files in the
 *  Commit Changes sidebar view inside the SCM container. Never declare this id
 *  in an extension manifest — it would shadow the renderer handler.
 *--------------------------------------------------------------------------------------------*/

import {
  Action2,
  ILayoutService,
  ILoggerService,
  IViewDescriptorService,
  IViewsService,
  localize2,
  type ServicesAccessor,
} from '@universe-editor/platform'
import type { ShowCommitChangesPayload } from '@universe-editor/extensions-common'
import { commitChangesViewState } from '../workbench/scm/commitChanges/viewState.js'

/** View id of the Commit Changes view; shared by the view registration
 *  (BuiltInViewsContribution) and the bridge action. Lives here rather than in
 *  the view component so neither side imports the other's React tree. */
export const COMMIT_CHANGES_VIEW_ID = 'workbench.view.scm.commitChanges'

function isFileEntry(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false
  const f = value as Record<string, unknown>
  return (
    typeof f['path'] === 'string' &&
    typeof f['status'] === 'string' &&
    (typeof f['oldPath'] === 'string' || f['oldPath'] === null) &&
    (typeof f['resourcePath'] === 'string' || f['resourcePath'] === null)
  )
}

function isMetadata(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false
  const m = value as Record<string, unknown>
  if (m['author'] !== undefined && typeof m['author'] !== 'string') return false
  if (m['authorDate'] !== undefined && typeof m['authorDate'] !== 'number') return false
  if (m['message'] !== undefined && typeof m['message'] !== 'string') return false
  if (m['parents'] !== undefined) {
    if (!Array.isArray(m['parents']) || !m['parents'].every((p) => typeof p === 'string')) {
      return false
    }
  }
  if (m['compareRefs'] !== undefined) {
    const c = m['compareRefs'] as Record<string, unknown> | null
    if (
      typeof c !== 'object' ||
      c === null ||
      typeof c['from'] !== 'string' ||
      typeof c['to'] !== 'string'
    ) {
      return false
    }
  }
  return true
}

function isShowCommitChangesPayload(value: unknown): value is ShowCommitChangesPayload {
  if (typeof value !== 'object' || value === null) return false
  const p = value as Record<string, unknown>
  return (
    typeof p['providerId'] === 'string' &&
    p['providerId'] !== '' &&
    typeof p['title'] === 'string' &&
    p['title'] !== '' &&
    typeof p['commitRef'] === 'string' &&
    p['commitRef'] !== '' &&
    typeof p['openExternalCommand'] === 'string' &&
    p['openExternalCommand'] !== '' &&
    Array.isArray(p['files']) &&
    p['files'].every(isFileEntry) &&
    (p['subtitle'] === undefined || typeof p['subtitle'] === 'string') &&
    (p['revealPath'] === undefined || typeof p['revealPath'] === 'string') &&
    (p['silent'] === undefined || typeof p['silent'] === 'boolean') &&
    (p['metadata'] === undefined || isMetadata(p['metadata']))
  )
}

export class ShowCommitChangesAction extends Action2 {
  static readonly ID = '_workbench.showCommitChanges'

  constructor() {
    super({
      id: ShowCommitChangesAction.ID,
      title: localize2('action.commitChanges.show', 'Show Commit Changes'),
    })
  }

  override run(accessor: ServicesAccessor, payload?: unknown): void {
    // Snapshot every service synchronously — the accessor dies past the first await.
    const viewsService = accessor.get(IViewsService)
    const viewDescriptorService = accessor.get(IViewDescriptorService)
    const logger = accessor
      .get(ILoggerService)
      .createLogger({ id: 'commitChanges', name: 'Commit Changes' })

    if (!isShowCommitChangesPayload(payload)) {
      logger.warn(`showCommitChanges rejected a malformed payload: ${JSON.stringify(payload)}`)
      return
    }

    logger.debug(
      `showing commit changes provider=${payload.providerId} ref=${payload.commitRef} silent=${payload.silent === true}`,
    )
    commitChangesViewState.show(payload)
    // Silent updates (graph selection follow) refresh the content only — the
    // sidebar must not pop open or expand the view on the user's behalf.
    if (payload.silent === true) return
    viewsService.openViewContainer('workbench.view.scm')
    viewDescriptorService.setViewCollapsed(COMMIT_CHANGES_VIEW_ID, false)
  }
}

/**
 * Focus the Commit Changes view: reveal the SCM container, expand the view and
 * move DOM focus into its file tree. No default keybinding — VSCode assigns
 * none to secondary views either; the command palette (f1) finds it.
 */
export class FocusCommitChangesAction extends Action2 {
  static readonly ID = 'workbench.view.scm.commitChanges.focus'

  constructor() {
    super({
      id: FocusCommitChangesAction.ID,
      title: localize2('action.commitChanges.focus', 'Focus on Commit Changes View'),
      category: localize2('command.category.view', 'View'),
      f1: true,
    })
  }

  override async run(accessor: ServicesAccessor): Promise<void> {
    // Snapshot every service synchronously — the accessor dies past the first await.
    const layoutService = accessor.get(ILayoutService)
    const viewsService = accessor.get(IViewsService)
    const viewDescriptorService = accessor.get(IViewDescriptorService)

    viewsService.openViewContainer('workbench.view.scm')
    viewDescriptorService.setViewCollapsed(COMMIT_CHANGES_VIEW_ID, false)
    await layoutService.focusView(COMMIT_CHANGES_VIEW_ID, { source: 'command' })
  }
}
