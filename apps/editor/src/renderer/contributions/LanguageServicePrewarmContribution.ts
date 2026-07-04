/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Idle-time prewarm of language services so opening the first file of a given
 *  language doesn't pay the cold start. Firing `onLanguage:<id>` activates the
 *  owning built-in plugin ahead of time; the TypeScript plugin further eager-
 *  spawns its tsserver and pins the workspace project on activation, so by the
 *  time a .ts file opens the server is warm and symbols are already searchable.
 *  Runs in the Eventually phase behind `runWhenIdle` (off the first-paint path),
 *  and re-runs whenever the extension host relaunches — a workspace swap or crash
 *  restart re-fires only the startup events, not `onLanguage:*`, so without this
 *  the new host never re-activates the language plugins.
 *--------------------------------------------------------------------------------------------*/

import {
  ConfigurationRegistry,
  Disposable,
  IConfigurationService,
  IWorkbenchContribution,
  IWorkspaceService,
  localize,
  runWhenIdle,
} from '@universe-editor/platform'
import { languageActivationEvent } from '@universe-editor/extensions-common'
import { IExtensionHostClientService } from '../services/extensions/ExtensionHostClientService.js'

const DEFAULT_PREWARM_LANGUAGES = ['typescript', 'markdown']

export class LanguageServicePrewarmContribution
  extends Disposable
  implements IWorkbenchContribution
{
  constructor(
    @IConfigurationService private readonly _config: IConfigurationService,
    @IWorkspaceService private readonly _workspace: IWorkspaceService,
    @IExtensionHostClientService private readonly _client: IExtensionHostClientService,
  ) {
    super()
    this._register(
      ConfigurationRegistry.registerConfiguration({
        id: 'languageServices',
        title: localize('settings.languageServices', 'Language Services'),
        properties: {
          'languageServices.prewarm': {
            type: 'array',
            items: { type: 'string' },
            default: DEFAULT_PREWARM_LANGUAGES,
            description: localize(
              'settings.languageServices.prewarm',
              'Language ids whose language service is prewarmed once the workspace is idle, so opening the first file of that language has no startup delay. Set to [] to disable.',
            ),
          },
        },
      }),
    )

    this._register(runWhenIdle(globalThis, () => void this._prewarm()))
    // A workspace swap / crash relaunches the host, which only re-fires the
    // startup events — the language plugins (onLanguage:*) would stay dormant.
    // onDidChangeContributions fires once the relaunched host's contracts are
    // ready, so re-prewarm then.
    this._register(this._client.onDidChangeContributions(() => void this._prewarm()))
  }

  private async _prewarm(): Promise<void> {
    const languages = this._config.get<string[]>(
      'languageServices.prewarm',
      DEFAULT_PREWARM_LANGUAGES,
    )
    if (!languages || languages.length === 0) return

    await this._workspace.whenReady
    await Promise.all(
      languages.map((lang) =>
        this._client.activateByEvent(languageActivationEvent(lang)).catch(() => undefined),
      ),
    )
  }
}
