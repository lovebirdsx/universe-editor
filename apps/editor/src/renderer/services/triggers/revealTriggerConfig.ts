/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Opens triggers.json and puts the cursor on the trigger / section the user is
 *  looking at. Shared by the configuration form's "Edit in JSON" buttons and the
 *  overview's "Reveal in JSON" action so the locate wording and the reveal dance
 *  live in one place.
 *--------------------------------------------------------------------------------------------*/

import {
  FileSystemError,
  IEditorGroupsService,
  IEditorResolverService,
  IEditorService,
  IFileService,
  IUriIdentityService,
  type URI,
} from '@universe-editor/platform'
import { parseWorkspaceUri } from '../../../shared/triggers/configParse.js'
import {
  triggerSectionLine,
  type TriggerConfigSection,
} from '../../../shared/triggers/configDocument.js'
import type { TriggerSummary } from '../../../shared/triggers/types.js'
import { findExistingFileEditor, openEditorAndReveal } from '../editor/revealEditorPosition.js'
import { readTriggerConfig, triggersConfigUri } from './triggerConfigFileService.js'

export interface TriggerConfigRevealServices {
  readonly files: IFileService
  readonly editors: IEditorResolverService
  readonly editorService: IEditorService
  readonly groups: IEditorGroupsService
  readonly uriIdentity: IUriIdentityService
}

/** Synchronous half: a caller that already holds the document text (the form). */
export function openTriggerConfigAt(
  services: Omit<TriggerConfigRevealServices, 'files'>,
  configUri: URI,
  text: string,
  triggerId: string,
  section: TriggerConfigSection = 'trigger',
): void {
  const line = triggerSectionLine(text, triggerId, section)
  if (line === undefined) {
    void services.editors.openEditor(configUri, { pinned: true })
    return
  }
  const existing = findExistingFileEditor(services.groups, services.uriIdentity, configUri)
  const input = existing?.editor ?? services.editors.createEditorInput(configUri)
  openEditorAndReveal(services.editorService, input, { startLineNumber: line, startColumn: 1 })
}

/** Read the workspace config and reveal {@link summary}'s definition in it. */
export async function revealTriggerConfig(
  services: TriggerConfigRevealServices,
  summary: TriggerSummary,
  section: TriggerConfigSection = 'trigger',
): Promise<void> {
  const workspaceUri = parseWorkspaceUri(summary.workspace)
  if (workspaceUri === undefined) return
  const configUri = triggersConfigUri(workspaceUri)
  let text: string | undefined
  try {
    text = (await readTriggerConfig(services.files, workspaceUri))?.text
  } catch (err) {
    // A missing / unreadable file cannot be located; opening the plain file lets
    // the editor create or report it instead of failing silently here.
    if (!(err instanceof FileSystemError)) throw err
  }
  if (text === undefined) {
    void services.editors.openEditor(configUri, { pinned: true })
    return
  }
  openTriggerConfigAt(services, configUri, text, summary.id, section)
}
