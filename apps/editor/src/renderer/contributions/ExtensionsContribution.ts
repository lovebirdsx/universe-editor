/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Boots the extension system: starts the host, pulls every extension's static
 *  contributions and translates them into the core registries (so contributed
 *  commands are immediately visible / lazily activatable), then fires the
 *  startup activation events. Per-command activation happens on first use via
 *  the bootstrap proxies the translator installs.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, type IWorkbenchContribution } from '@universe-editor/platform'
import { STARTUP_ACTIVATION, STARTUP_FINISHED_ACTIVATION } from '@universe-editor/extensions-common'
import { IExtensionHostClientService } from '../services/extensions/ExtensionHostClientService.js'
import { ExtensionPointTranslator } from '../services/extensions/ExtensionPointTranslator.js'
import { IUserKeybindingsService } from '../services/keybindings/UserKeybindingsService.js'
import { E2E_PROBE_ENABLED_KEY } from '../../shared/e2e/contract.js'

export class ExtensionsContribution extends Disposable implements IWorkbenchContribution {
  constructor(
    @IExtensionHostClientService private readonly _client: IExtensionHostClientService,
    @IUserKeybindingsService private readonly _userKeybindings: IUserKeybindingsService,
  ) {
    super()
    void this._boot()
  }

  private async _boot(): Promise<void> {
    // E2E: the extension host is a child process whose occasional spawn/crash
    // under CI emits background notifications + error logs that pollute unrelated
    // smoke assertions (the notification bell badge, Output auto-reveal). No
    // smoke spec exercises extensions, so skip the host entirely — equivalent to
    // VSCode's `--disable-extensions` test convention.
    const isE2E = typeof window !== 'undefined' && window[E2E_PROBE_ENABLED_KEY] === true
    if (isE2E) return

    const translator = this._register(
      new ExtensionPointTranslator(
        (event) => this._client.activateByEvent(event),
        (id, args) => this._client.executeContributedCommand(id, args),
      ),
    )

    const contributions = await this._client.getContributions()
    translator.translate(contributions)

    // Extension commands are now in CommandsRegistry; re-apply VSCode/user
    // keybindings so bindings to those commands (skipped at startup) take effect.
    await this._userKeybindings.reload()

    await this._client.activateByEvent(STARTUP_ACTIVATION)
    await this._client.activateByEvent(STARTUP_FINISHED_ACTIVATION)
  }
}
