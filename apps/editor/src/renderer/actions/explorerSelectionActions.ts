import {
  Action2,
  KeybindingWeight,
  localize2,
  type ServicesAccessor,
} from '@universe-editor/platform'
import { IExplorerTreeService } from '../services/explorer/ExplorerTreeService.js'
import { EXPLORER_FOCUS_WHEN } from './fileActionsCommon.js'

export class CancelExplorerMultiSelectionAction extends Action2 {
  static readonly ID = 'filesExplorer.cancelMultiSelection'
  constructor() {
    super({
      id: CancelExplorerMultiSelectionAction.ID,
      title: localize2('action.filesExplorer.cancelMultiSelection', 'Cancel Multi-Selection'),
      category: localize2('command.category.file', 'File'),
      keybinding: {
        primary: 'escape',
        // Scoped Explorer bindings must outrank default-weight global Escape
        // bindings (e.g. Markdown find close) by weight, not registration order.
        weight: KeybindingWeight.WorkbenchContrib + 50,
        // Cut cancellation owns Escape when both gestures are pending.
        when: `${EXPLORER_FOCUS_WHEN} && explorerMultiSelection && !explorerResourceCut`,
      },
      f1: false,
    })
  }

  override run(accessor: ServicesAccessor): void {
    accessor.get(IExplorerTreeService).collapseSelectionToFocus()
  }
}
