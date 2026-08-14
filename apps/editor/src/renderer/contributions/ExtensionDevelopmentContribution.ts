/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  ExtensionDevelopmentContribution — surfaces extension-development mode
 *  (--extension-development-path) in the UI: a StatusBar entry showing how many
 *  dev extensions the host loaded, with their source roots in the tooltip.
 *  Clicking it opens the Extensions view. The window-title badge lives in
 *  WindowTitleContribution; this is the at-a-glance counterpart in the workbench.
 *
 *  The whole contribution is a no-op outside extension-development mode.
 *--------------------------------------------------------------------------------------------*/

import {
  Disposable,
  IStatusBarService,
  StatusBarAlignment,
  URI,
  localize,
  type IStatusBarEntryAccessor,
  type IWorkbenchContribution,
} from '@universe-editor/platform'
import type { IExtensionDescriptionDto } from '@universe-editor/extensions-common'
import { EXTENSION_DEVELOPMENT_ENABLED_KEY } from '../../shared/extensionDevelopment.js'
import { ShowExtensionsAction } from '../actions/extensionsActions.js'
import { IExtensionHostClientService } from '../services/extensions/ExtensionHostClientService.js'

export class ExtensionDevelopmentContribution extends Disposable implements IWorkbenchContribution {
  private _accessor: IStatusBarEntryAccessor | undefined

  constructor(
    @IStatusBarService private readonly _statusBar: IStatusBarService,
    @IExtensionHostClientService private readonly _hostClient: IExtensionHostClientService,
  ) {
    super()
    // The typeof guard keeps this constructible in a DOM-less (node) test env.
    if (typeof window === 'undefined' || window[EXTENSION_DEVELOPMENT_ENABLED_KEY] !== true) return
    // The count comes from the host's contributions; a restart re-scans, so
    // recompute on every change instead of counting once (a dev extension
    // added between restarts must show up after "Restart Extension Host").
    this._register(this._hostClient.onDidChangeContributions((dtos) => this._render(dtos)))
    this._register({ dispose: () => this._accessor?.dispose() })
    void this._hostClient.getContributions().then((dtos) => this._render(dtos))
  }

  private _render(dtos: readonly IExtensionDescriptionDto[]): void {
    const dev = dtos.filter((d) => d.extensionIsUnderDevelopment === true)
    // The status-bar icon map is tiny (bell/sparkle/shield); a codicon inline in
    // the text renders everywhere instead.
    const entry = {
      text: `$(debug-alt) ${localize('extDev.statusBar', 'Extension Development Host ({count})', {
        count: dev.length,
      })}`,
      tooltip: localize(
        'extDev.statusBar.tooltip',
        'Extension Development Host: {count} extension(s) loaded from source\n{paths}',
        {
          count: dev.length,
          paths: dev.map((d) => URI.revive(d.extensionLocation)!.fsPath).join('\n'),
        },
      ),
      command: ShowExtensionsAction.ID,
      alignment: StatusBarAlignment.Left,
      priority: 9,
    }
    if (this._accessor) this._accessor.update(entry)
    else this._accessor = this._statusBar.addEntry(entry)
  }
}
