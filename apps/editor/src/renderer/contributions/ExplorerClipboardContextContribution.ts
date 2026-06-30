import {
  Disposable,
  IContextKeyService,
  type IWorkbenchContribution,
} from '@universe-editor/platform'
import { IExplorerTreeService } from '../services/explorer/ExplorerTreeService.js'
import type { ExplorerTreeService } from '../services/explorer/ExplorerTreeService.js'

export class ExplorerClipboardContextContribution
  extends Disposable
  implements IWorkbenchContribution
{
  constructor(
    @IContextKeyService contextKeyService: IContextKeyService,
    @IExplorerTreeService explorerTreeService: ExplorerTreeService,
  ) {
    super()

    const fileCopied = contextKeyService.createKey<boolean>(
      'fileCopied',
      explorerTreeService.hasClipboard,
    )
    const explorerResourceCut = contextKeyService.createKey<boolean>(
      'explorerResourceCut',
      explorerTreeService.hasCutItems,
    )
    const sync = () => {
      fileCopied.set(explorerTreeService.hasClipboard)
      explorerResourceCut.set(explorerTreeService.hasCutItems)
    }

    this._register(explorerTreeService.onDidChangeClipboard(sync))
    sync()
  }
}
