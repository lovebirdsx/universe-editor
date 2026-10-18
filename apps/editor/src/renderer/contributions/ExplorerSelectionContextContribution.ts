import {
  Disposable,
  IContextKeyService,
  type IWorkbenchContribution,
} from '@universe-editor/platform'
import { IExplorerTreeService } from '../services/explorer/ExplorerTreeService.js'
import type { ExplorerTreeService } from '../services/explorer/ExplorerTreeService.js'

/**
 * Root-level mirror of "the Explorer has more than one row selected". Menu
 * when-clauses are evaluated against a scoped context, but keybindings read the
 * root one, so Escape's "only when something to cancel" gate needs its own key.
 */
export class ExplorerSelectionContextContribution
  extends Disposable
  implements IWorkbenchContribution
{
  constructor(
    @IContextKeyService contextKeyService: IContextKeyService,
    @IExplorerTreeService explorerTreeService: ExplorerTreeService,
  ) {
    super()
    const multiSelection = contextKeyService.createKey<boolean>(
      'explorerMultiSelection',
      explorerTreeService.selectionCount > 1,
    )
    this._register({ dispose: () => multiSelection.reset() })
    this._register(
      explorerTreeService.onDidChangeSelection(() =>
        multiSelection.set(explorerTreeService.selectionCount > 1),
      ),
    )
  }
}
