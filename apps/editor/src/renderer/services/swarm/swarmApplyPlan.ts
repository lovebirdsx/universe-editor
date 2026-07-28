/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  planApplyToLocal — pure classification of a review version's files for the
 *  "Apply to Local" command: which depot files to send to the host, which mapped
 *  paths get skipped because they live outside the workspace (unless the user
 *  opted in), and which files aren't mapped into the client at all. Pure so the
 *  dialog wording and the command request are unit-testable without React.
 *--------------------------------------------------------------------------------------------*/

import type { SwarmReviewFileDto } from '@universe-editor/extensions-common'

export interface ApplyPlan {
  /** Depot files to send to the host (`p4 unshelve -s <change> -f <files>`). */
  readonly depotFiles: string[]
  /** Display paths of mapped files skipped because they are outside the
   *  workspace and the toggle is off. */
  readonly outsidePaths: string[]
  /** Display paths of files with `localPath === null` (not mapped in the client
   *  view) — always skipped; p4 cannot restore them anywhere. */
  readonly unmappedPaths: string[]
}

export function planApplyToLocal(
  files: readonly SwarmReviewFileDto[],
  includeOutside: boolean,
  isInWorkspace: (fsPath: string) => boolean,
): ApplyPlan {
  const depotFiles: string[] = []
  const outsidePaths: string[] = []
  const unmappedPaths: string[] = []
  for (const file of files) {
    if (file.localPath === null) {
      unmappedPaths.push(file.path)
      continue
    }
    if (!includeOutside && !isInWorkspace(file.localPath)) {
      outsidePaths.push(file.path)
      continue
    }
    depotFiles.push(file.depotFile)
  }
  return { depotFiles, outsidePaths, unmappedPaths }
}
