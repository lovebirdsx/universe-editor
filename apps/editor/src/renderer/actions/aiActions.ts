/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  AI-related Action2 definitions: store / clear the OpenAI API key. The key is
 *  handed to the AI model service, which persists it in encrypted secret storage
 *  in main — it never lands in settings.json or the renderer's state.
 *--------------------------------------------------------------------------------------------*/

import {
  Action2,
  IAiModelService,
  IDialogService,
  INotificationService,
  IQuickInputService,
  Severity,
  localize,
  type ServicesAccessor,
} from '@universe-editor/platform'

const CATEGORY = localize('command.category.ai', 'AI')
const OPENAI_VENDOR = 'openai'

export class SetOpenAiApiKeyAction extends Action2 {
  static readonly ID = 'ai.setOpenAiApiKey'
  constructor() {
    super({
      id: SetOpenAiApiKeyAction.ID,
      title: localize('action.ai.setOpenAiApiKey', 'Set OpenAI API Key'),
      category: CATEGORY,
      f1: true,
    })
  }
  override async run(accessor: ServicesAccessor): Promise<void> {
    const quickInput = accessor.get(IQuickInputService)
    const aiModel = accessor.get(IAiModelService)
    const notification = accessor.get(INotificationService)

    const key = await quickInput.input({
      prompt: localize(
        'ai.setOpenAiApiKey.prompt',
        'Enter your OpenAI API key (stored encrypted; never written to settings.json).',
      ),
      placeholder: 'sk-…',
      validateInput: (value) =>
        value.trim().length === 0
          ? localize('ai.setOpenAiApiKey.empty', 'The API key must not be empty.')
          : undefined,
    })
    const trimmed = key?.trim()
    if (!trimmed) return

    await aiModel.setApiKey(OPENAI_VENDOR, trimmed)
    notification.notify({
      severity: Severity.Info,
      message: localize('ai.setOpenAiApiKey.done', 'OpenAI API key saved.'),
    })
  }
}

export class ClearOpenAiApiKeyAction extends Action2 {
  static readonly ID = 'ai.clearOpenAiApiKey'
  constructor() {
    super({
      id: ClearOpenAiApiKeyAction.ID,
      title: localize('action.ai.clearOpenAiApiKey', 'Clear OpenAI API Key'),
      category: CATEGORY,
      f1: true,
    })
  }
  override async run(accessor: ServicesAccessor): Promise<void> {
    const dialog = accessor.get(IDialogService)
    const aiModel = accessor.get(IAiModelService)
    const notification = accessor.get(INotificationService)

    if (!(await aiModel.hasApiKey(OPENAI_VENDOR))) {
      notification.notify({
        severity: Severity.Info,
        message: localize('ai.clearOpenAiApiKey.none', 'No OpenAI API key is stored.'),
      })
      return
    }

    const { confirmed } = await dialog.confirm({
      message: localize('ai.clearOpenAiApiKey.confirm', 'Clear the stored OpenAI API key?'),
      primaryButton: localize('ai.clearOpenAiApiKey.clear', 'Clear'),
      type: 'warning',
    })
    if (!confirmed) return

    await aiModel.deleteApiKey(OPENAI_VENDOR)
    notification.notify({
      severity: Severity.Info,
      message: localize('ai.clearOpenAiApiKey.done', 'OpenAI API key cleared.'),
    })
  }
}
