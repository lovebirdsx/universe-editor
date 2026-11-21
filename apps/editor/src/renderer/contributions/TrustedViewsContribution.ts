/*---------------------------------------------------------------------------------------------
 *  Static bindings for trusted views: the shared componentKey every contributed
 *  `location: 'view'` entry renders through, and the editor provider for
 *  `TrustedViewEditorInput`.
 *
 *  BlockStartup, like the other built-in editor providers: WorkspaceRestore
 *  deserializes `trustedView` tabs during BlockRestore, so the provider must
 *  already be registered.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, type IWorkbenchContribution } from '@universe-editor/platform'
import { registerEditorWithComponent } from '../services/editor/EditorComponentRegistry.js'
import { TrustedViewEditorInput } from '../services/editor/TrustedViewEditorInput.js'
import { ViewComponentRegistry } from '../services/views/ViewComponentRegistry.js'
import { EXTENSION_TRUSTED_VIEW_COMPONENT_KEY } from '../services/views/trustedViews.js'
import { TrustedViewEditor, TrustedViewView } from '../workbench/trustedViews/TrustedViewHost.js'

export class TrustedViewsContribution extends Disposable implements IWorkbenchContribution {
  constructor() {
    super()
    this._register(
      ViewComponentRegistry.register(EXTENSION_TRUSTED_VIEW_COMPONENT_KEY, TrustedViewView),
    )
    this._register(
      registerEditorWithComponent(
        {
          typeId: TrustedViewEditorInput.TYPE_ID,
          deserialize: (data) => TrustedViewEditorInput.deserialize(data),
        },
        TrustedViewEditor,
      ),
    )
  }
}
