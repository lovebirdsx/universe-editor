/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Boots the extension system: starts the host, pulls every extension's static
 *  contributions and translates them into the core registries (so contributed
 *  commands are immediately visible / lazily activatable), then fires the
 *  startup activation events. Per-command activation happens on first use via
 *  the bootstrap proxies the translator installs.
 *--------------------------------------------------------------------------------------------*/

import {
  Disposable,
  IConfigurationService,
  IFileService,
  ILoggerService,
  MutableDisposable,
  NullLogger,
  type ILogger,
  type IWorkbenchContribution,
} from '@universe-editor/platform'
import {
  STARTUP_ACTIVATION,
  STARTUP_FINISHED_ACTIVATION,
  type IExtensionDescriptionDto,
} from '@universe-editor/extensions-common'
import { IExtensionHostClientService } from '../services/extensions/ExtensionHostClientService.js'
import { ExtensionPointTranslator } from '../services/extensions/ExtensionPointTranslator.js'
import { IUserKeybindingsService } from '../services/keybindings/UserKeybindingsService.js'
import { IRemoteSchemaService } from '../../shared/ipc/remoteSchemaService.js'
import { resolveSchemaFromUrl } from '../services/preferences/schemaUrlResolver.js'

export class ExtensionsContribution extends Disposable implements IWorkbenchContribution {
  private readonly _translator = this._register(new MutableDisposable<ExtensionPointTranslator>())
  private readonly _logger: ILogger

  constructor(
    @IExtensionHostClientService private readonly _client: IExtensionHostClientService,
    @IUserKeybindingsService private readonly _userKeybindings: IUserKeybindingsService,
    @IConfigurationService private readonly _configuration: IConfigurationService,
    @IFileService private readonly _fileService: IFileService,
    @IRemoteSchemaService private readonly _remoteSchema: IRemoteSchemaService,
    @ILoggerService loggerService: ILoggerService,
  ) {
    super()
    this._logger =
      loggerService?.createLogger({ id: 'extensionSchemas', name: 'Extension Schemas' }) ??
      new NullLogger()
    void this._boot()
  }

  private async _boot(): Promise<void> {
    // A host relaunch (workspace swap / crash) re-emits its contributions; re-apply
    // them so contributed commands survive a restart that raced this initial boot.
    this._register(
      this._client.onDidChangeContributions((contributions) =>
        this._applyContributions(contributions),
      ),
    )

    try {
      const contributions = await this._client.getContributions()
      this._applyContributions(contributions)
    } catch {
      // The initial pull lost a race with a workspace/crash restart; that
      // restart's onDidChangeContributions event drives translation instead.
    }

    await this._client.activateByEvent(STARTUP_ACTIVATION)
    await this._client.activateByEvent(STARTUP_FINISHED_ACTIVATION)
  }

  /** Dispose the previous translation and re-apply the current contribution set. */
  private _applyContributions(contributions: readonly IExtensionDescriptionDto[]): void {
    this._translator.clear()
    const translator = new ExtensionPointTranslator(
      (event) => this._client.activateByEvent(event),
      (id, args) => this._client.executeContributedCommand(id, args),
      (url) =>
        resolveSchemaFromUrl(
          url,
          {
            configuration: this._configuration,
            fileService: this._fileService,
            remoteSchema: this._remoteSchema,
            logger: this._logger,
          },
          'jsonValidation',
        ),
      this._logger,
    )
    translator.translate(contributions)
    this._translator.value = translator

    // Extension commands are now in CommandsRegistry; re-apply VSCode/user
    // keybindings so bindings to those commands (skipped at startup) take effect.
    void this._userKeybindings.reload()
  }
}
