import {
  Disposable,
  IContextKeyService,
  URI,
  type IWorkbenchContribution,
} from '@universe-editor/platform'
import { IExplorerTreeService } from '../services/explorer/ExplorerTreeService.js'
import type { ExplorerTreeService } from '../services/explorer/ExplorerTreeService.js'
import {
  IFileClipboardService,
  type IFileClipboardSnapshot,
} from '../../shared/ipc/fileClipboardService.js'

export class ExplorerClipboardContextContribution
  extends Disposable
  implements IWorkbenchContribution
{
  constructor(
    @IContextKeyService contextKeyService: IContextKeyService,
    @IExplorerTreeService explorerTreeService: ExplorerTreeService,
    @IFileClipboardService fileClipboard: IFileClipboardService,
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
    // One-way mirror: shared clipboard → tree local state + context keys.
    // Never write back to the shared service — the ProxyChannel broadcast
    // includes the originating window, so writing back would loop forever.
    const adopt = (snapshot: IFileClipboardSnapshot) => {
      if (this._store.isDisposed) return
      explorerTreeService.adoptClipboard(
        snapshot.resources.flatMap((entry) => {
          const resource = URI.revive(entry.resource)
          return resource ? [{ resource, isDirectory: entry.isDirectory }] : []
        }),
        snapshot.isCut,
      )
      sync()
    }
    this._register(fileClipboard.onDidChangeClipboard(adopt))
    // Tree-internal clears (rename/delete/move of a cut item, workspace
    // switch) update the context keys synchronously without waiting for the
    // shared-clear roundtrip.
    this._register(explorerTreeService.onDidChangeClipboard(sync))
    sync()
    // Startup snapshot: after a window reload the renderer state is gone while
    // the main-process clipboard is the only truth source — re-adopt it so cut
    // dimming and context keys survive the reload.
    void fileClipboard
      .readResources()
      .then(adopt)
      .catch(() => {})
  }
}
