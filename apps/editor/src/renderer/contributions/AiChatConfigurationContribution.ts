/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Registers the ai.chat.* settings. Currently just the active chat model id,
 *  which AiModelClientService reads/writes so the selection lives in
 *  settings.json instead of opaque storage.
 *--------------------------------------------------------------------------------------------*/

import {
  ConfigurationRegistry,
  Disposable,
  IWorkbenchContribution,
  localize,
} from '@universe-editor/platform'

export class AiChatConfigurationContribution extends Disposable implements IWorkbenchContribution {
  constructor() {
    super()
    this._register(
      ConfigurationRegistry.registerConfiguration({
        id: 'ai',
        title: localize('settings.ai', 'AI'),
        properties: {
          'ai.chat.model': {
            type: 'string',
            default: '',
            description: localize(
              'settings.ai.chat.model',
              'The active AI model id used for chat (e.g. "openai/default/gpt-4o"). Leave empty to pick one from the status bar.',
            ),
          },
        },
      }),
    )
  }
}
