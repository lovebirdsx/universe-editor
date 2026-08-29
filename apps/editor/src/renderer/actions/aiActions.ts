/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  AI-related Action2 definitions: pick the active model, open the model manager
 *  / aiSettings.json, and store / clear a provider entry's API key. Keys are
 *  handed to the AI model service, which persists them on the entry in
 *  aiSettings.json (user decision: cross-machine sync) — never logged.
 *--------------------------------------------------------------------------------------------*/

import {
  Action2,
  IAiModelService,
  IDialogService,
  IEditorGroupsService,
  IInstantiationService,
  INotificationService,
  IQuickInputService,
  IUserDataFilesService,
  Severity,
  UserDataFile,
  localize,
  localize2,
  type AiProviderEntry,
  type ServicesAccessor,
} from '@universe-editor/platform'
import { FileEditorInput } from '../services/editor/FileEditorInput.js'
import { openInLockAwareGroup } from '../services/editor/openInLockAwareGroup.js'
import { revealEditorInGroups } from '../services/editor/revealEditorInGroups.js'
import { AiSettingsEditorInput } from '../services/editor/AiSettingsEditorInput.js'
import { buildModelPickItems } from './aiModelPickItems.js'

const CATEGORY = localize2('command.category.ai', 'AI')

const MANAGE_ITEM_ID = '__manage__'

export class PickModelAction extends Action2 {
  static readonly ID = 'ai.pickModel'
  constructor() {
    super({
      id: PickModelAction.ID,
      title: localize2('action.ai.pickModel', 'Select AI Model'),
      category: CATEGORY,
      f1: true,
    })
  }
  override async run(accessor: ServicesAccessor): Promise<void> {
    const quickInput = accessor.get(IQuickInputService)
    const aiModel = accessor.get(IAiModelService)
    const instantiation = accessor.get(IInstantiationService)

    const [models, active] = await Promise.all([aiModel.getModels(), aiModel.getActiveModelId()])
    const items = buildModelPickItems(models, active)

    const picked = await quickInput.pick(items, {
      id: 'ai.pickModel',
      placeholder: localize('ai.pickModel.placeholder', 'Select the active AI model'),
      matchOnDescription: true,
      buttons: [
        {
          id: MANAGE_ITEM_ID,
          iconId: 'gear',
          tooltip: localize('ai.pickModel.manage', 'Open AI Settings…'),
        },
      ],
      onDidTriggerButton: () => {
        void instantiation.invokeFunction((a) => new ManageModelsAction().run(a))
      },
    })
    if (!picked) return
    if (picked.modelId) await aiModel.setActiveModelId(picked.modelId)
  }
}

export class ManageModelsAction extends Action2 {
  static readonly ID = 'ai.manageModels'
  constructor() {
    super({
      id: ManageModelsAction.ID,
      title: localize2('action.ai.openSettings', 'Open AI & Agent Settings'),
      category: CATEGORY,
      f1: true,
    })
  }
  override run(accessor: ServicesAccessor): void {
    const groups = accessor.get(IEditorGroupsService)
    if (revealEditorInGroups(groups, (e) => e instanceof AiSettingsEditorInput)) return
    openInLockAwareGroup(groups, new AiSettingsEditorInput())
  }
}

export class OpenAiSettingsJsonAction extends Action2 {
  static readonly ID = 'ai.openSettingsJson'
  constructor() {
    super({
      id: OpenAiSettingsJsonAction.ID,
      title: localize2('action.ai.openSettingsJson', 'Open AI Settings (JSON)'),
      category: CATEGORY,
      f1: true,
    })
  }
  override async run(accessor: ServicesAccessor): Promise<void> {
    const aiModel = accessor.get(IAiModelService)
    const userData = accessor.get(IUserDataFilesService)
    const groups = accessor.get(IEditorGroupsService)
    const inst = accessor.get(IInstantiationService)

    // Materialize the file (seeds defaults when missing) so it opens with content.
    await aiModel.updateProviders(await aiModel.getProviders())
    const uri = await userData.getFileUri(UserDataFile.AiSettings)
    if (!uri) return
    const input = inst.createInstance(FileEditorInput, uri)
    openInLockAwareGroup(groups, input, { activate: true })
  }
}

export class SetApiKeyAction extends Action2 {
  static readonly ID = 'ai.setApiKey'
  constructor() {
    super({
      id: SetApiKeyAction.ID,
      title: localize2('action.ai.setApiKey', 'Set AI Provider API Key'),
      category: CATEGORY,
      f1: true,
    })
  }
  override async run(accessor: ServicesAccessor): Promise<void> {
    const quickInput = accessor.get(IQuickInputService)
    const aiModel = accessor.get(IAiModelService)
    const notification = accessor.get(INotificationService)

    const provider = await pickProvider(quickInput, await aiModel.getProviders())
    if (!provider) return

    const key = await quickInput.input({
      prompt: localize(
        'ai.setApiKey.prompt',
        'Enter the API key for {provider}. Stored in plain text in aiSettings.json (kept in sync across machines).',
        { provider: provider.id },
      ),
      placeholder: 'sk-…',
      validateInput: (value) =>
        value.trim().length === 0
          ? localize('ai.setApiKey.empty', 'The API key must not be empty.')
          : undefined,
    })
    const trimmed = key?.trim()
    if (!trimmed) return

    await aiModel.setApiKey(provider.id, trimmed)
    notification.notify({
      severity: Severity.Info,
      message: localize('ai.setApiKey.done', 'API key saved for {provider}.', {
        provider: provider.id,
      }),
    })
  }
}

export class ClearApiKeyAction extends Action2 {
  static readonly ID = 'ai.clearApiKey'
  constructor() {
    super({
      id: ClearApiKeyAction.ID,
      title: localize2('action.ai.clearApiKey', 'Clear AI Provider API Key'),
      category: CATEGORY,
      f1: true,
    })
  }
  override async run(accessor: ServicesAccessor): Promise<void> {
    const dialog = accessor.get(IDialogService)
    const aiModel = accessor.get(IAiModelService)
    const notification = accessor.get(INotificationService)
    const quickInput = accessor.get(IQuickInputService)

    const provider = await pickProvider(quickInput, await aiModel.getProviders())
    if (!provider) return

    if (!(await aiModel.hasApiKey(provider.id))) {
      notification.notify({
        severity: Severity.Info,
        message: localize('ai.clearApiKey.none', 'No API key is stored for {provider}.', {
          provider: provider.id,
        }),
      })
      return
    }

    const { confirmed } = await dialog.confirm({
      message: localize('ai.clearApiKey.confirm', 'Clear the stored API key for {provider}?', {
        provider: provider.id,
      }),
      primaryButton: localize('ai.clearApiKey.clear', 'Clear'),
      type: 'warning',
    })
    if (!confirmed) return

    await aiModel.deleteApiKey(provider.id)
    notification.notify({
      severity: Severity.Info,
      message: localize('ai.clearApiKey.done', 'API key cleared for {provider}.', {
        provider: provider.id,
      }),
    })
  }
}

async function pickProvider(
  quickInput: IQuickInputService,
  providers: readonly AiProviderEntry[],
): Promise<AiProviderEntry | undefined> {
  if (providers.length === 0) return undefined
  if (providers.length === 1) return providers[0]
  const items = providers.map((p) => ({
    id: p.id,
    label: p.id,
    ...(p.baseUrl !== undefined ? { description: p.baseUrl } : {}),
  }))
  const picked = await quickInput.pick(items, {
    id: 'ai.pickProvider',
    placeholder: localize('ai.pickProvider.placeholder', 'Select a provider'),
  })
  if (!picked) return undefined
  return providers.find((p) => p.id === picked.id)
}
