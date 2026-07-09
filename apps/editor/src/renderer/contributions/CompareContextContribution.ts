/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Keeps the compare-related context keys in sync:
 *   - `resourceSelectedForCompare`: a resource was picked via "Select for Compare"
 *   - `explorerResourceTwoSelected`: exactly two files are selected in the tree
 *   - `explorerResourceMultiSelected`: more than one file is selected in the tree
 *  All gate the compare entries in the Explorer context menu.
 *--------------------------------------------------------------------------------------------*/

import {
  Disposable,
  IContextKeyService,
  type IWorkbenchContribution,
} from '@universe-editor/platform'
import { IExplorerTreeService } from '../services/explorer/ExplorerTreeService.js'
import type { ExplorerTreeService } from '../services/explorer/ExplorerTreeService.js'
import { ICompareService } from '../services/explorer/CompareService.js'

export class CompareContextContribution extends Disposable implements IWorkbenchContribution {
  constructor(
    @IContextKeyService contextKeyService: IContextKeyService,
    @IExplorerTreeService explorerTreeService: ExplorerTreeService,
    @ICompareService compareService: ICompareService,
  ) {
    super()

    const resourceSelectedForCompare = contextKeyService.createKey<boolean>(
      'resourceSelectedForCompare',
      compareService.selectedResource !== null,
    )
    this._register(
      compareService.onDidChange(() => {
        resourceSelectedForCompare.set(compareService.selectedResource !== null)
      }),
    )

    const explorerResourceTwoSelected = contextKeyService.createKey<boolean>(
      'explorerResourceTwoSelected',
      false,
    )
    const explorerResourceMultiSelected = contextKeyService.createKey<boolean>(
      'explorerResourceMultiSelected',
      false,
    )
    const syncSelection = () => {
      const files = explorerTreeService.selection.filter(
        (uri) => !explorerTreeService.isDirectory(uri) && !explorerTreeService.isRoot(uri),
      )
      explorerResourceTwoSelected.set(files.length === 2)
      explorerResourceMultiSelected.set(files.length > 1)
    }
    this._register(explorerTreeService.onDidChangeSelection(syncSelection))
    syncSelection()
  }
}
