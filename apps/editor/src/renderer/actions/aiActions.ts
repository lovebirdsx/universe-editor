/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  AI-related Action2 definitions: pick the active model, open the model manager
 *  / aiSettings.json, and store / clear a provider group's API key. Keys are handed
 *  to the AI model service, which persists them in encrypted secret storage in
 *  main — they never land in aiSettings.json or the renderer's state.
 *--------------------------------------------------------------------------------------------*/

import {
  Action2,
  groupKey,
  IAiModelService,
  IDialogService,
  IEditorGroupsService,
  IInstantiationService,
  INotificationService,
  IQuickInputService,
  IUserDataFilesService,
  Severity,
  URI,
  UserDataFile,
  localize,
  type AiModelMetadata,
  type AiProviderGroup,
  type IQuickPickItem,
  type QuickPickInput,
  type ServicesAccessor,
} from '@universe-editor/platform'
import { FileEditorInput } from '../services/editor/FileEditorInput.js'
import { AiSettingsEditorInput } from '../services/editor/AiSettingsEditorInput.js'

const CATEGORY = localize('command.category.ai', 'AI')

const MANAGE_ITEM_ID = '__manage__'

interface ModelPickItem extends IQuickPickItem {
  readonly modelId?: string
}

export class PickModelAction extends Action2 {
  static readonly ID = 'ai.pickModel'
  constructor() {
    super({
      id: PickModelAction.ID,
      title: localize('action.ai.pickModel', 'Select AI Model'),
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
          tooltip: localize('ai.pickModel.manage', 'Manage Models…'),
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
      title: localize('action.ai.manageModels', 'Manage AI Models'),
      category: CATEGORY,
      f1: true,
    })
  }
  override run(accessor: ServicesAccessor): void {
    const groups = accessor.get(IEditorGroupsService)
    for (const group of groups.groups) {
      for (const editor of group.editors) {
        if (editor instanceof AiSettingsEditorInput) {
          groups.activateGroup(group)
          group.setActive(editor)
          return
        }
      }
    }
    groups.activeGroup.openEditor(new AiSettingsEditorInput())
  }
}

export class OpenAiSettingsJsonAction extends Action2 {
  static readonly ID = 'ai.openSettingsJson'
  constructor() {
    super({
      id: OpenAiSettingsJsonAction.ID,
      title: localize('action.ai.openSettingsJson', 'Open AI Settings (JSON)'),
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
    await aiModel.updateGroups(await aiModel.getGroups())
    const uri = await userData.getFileUri(UserDataFile.AiSettings)
    if (!uri) return
    const input = inst.createInstance(FileEditorInput, URI.revive(uri) as URI)
    groups.activeGroup.openEditor(input, { activate: true })
  }
}

export class SetApiKeyAction extends Action2 {
  static readonly ID = 'ai.setApiKey'
  constructor() {
    super({
      id: SetApiKeyAction.ID,
      title: localize('action.ai.setApiKey', 'Set AI Provider API Key'),
      category: CATEGORY,
      f1: true,
    })
  }
  override async run(accessor: ServicesAccessor): Promise<void> {
    const quickInput = accessor.get(IQuickInputService)
    const aiModel = accessor.get(IAiModelService)
    const notification = accessor.get(INotificationService)

    const group = await pickGroup(quickInput, await aiModel.getGroups())
    if (!group) return

    const key = await quickInput.input({
      prompt: localize(
        'ai.setApiKey.prompt',
        'Enter the API key for {group} (stored encrypted; never written to aiSettings.json).',
        { group: groupKey(group) },
      ),
      placeholder: 'sk-…',
      validateInput: (value) =>
        value.trim().length === 0
          ? localize('ai.setApiKey.empty', 'The API key must not be empty.')
          : undefined,
    })
    const trimmed = key?.trim()
    if (!trimmed) return

    await aiModel.setApiKey(group.vendor, group.name, trimmed)
    notification.notify({
      severity: Severity.Info,
      message: localize('ai.setApiKey.done', 'API key saved for {group}.', {
        group: groupKey(group),
      }),
    })
  }
}

export class ClearApiKeyAction extends Action2 {
  static readonly ID = 'ai.clearApiKey'
  constructor() {
    super({
      id: ClearApiKeyAction.ID,
      title: localize('action.ai.clearApiKey', 'Clear AI Provider API Key'),
      category: CATEGORY,
      f1: true,
    })
  }
  override async run(accessor: ServicesAccessor): Promise<void> {
    const dialog = accessor.get(IDialogService)
    const aiModel = accessor.get(IAiModelService)
    const notification = accessor.get(INotificationService)
    const quickInput = accessor.get(IQuickInputService)

    const group = await pickGroup(quickInput, await aiModel.getGroups())
    if (!group) return

    if (!(await aiModel.hasApiKey(group.vendor, group.name))) {
      notification.notify({
        severity: Severity.Info,
        message: localize('ai.clearApiKey.none', 'No API key is stored for {group}.', {
          group: groupKey(group),
        }),
      })
      return
    }

    const { confirmed } = await dialog.confirm({
      message: localize('ai.clearApiKey.confirm', 'Clear the stored API key for {group}?', {
        group: groupKey(group),
      }),
      primaryButton: localize('ai.clearApiKey.clear', 'Clear'),
      type: 'warning',
    })
    if (!confirmed) return

    await aiModel.deleteApiKey(group.vendor, group.name)
    notification.notify({
      severity: Severity.Info,
      message: localize('ai.clearApiKey.done', 'API key cleared for {group}.', {
        group: groupKey(group),
      }),
    })
  }
}

function buildModelPickItems(
  models: readonly AiModelMetadata[],
  active: string | undefined,
): QuickPickInput<ModelPickItem>[] {
  const items: QuickPickInput<ModelPickItem>[] = []
  let lastGroup: string | undefined
  for (const model of models) {
    const label = `${model.vendor}/${model.groupName ?? 'default'}`
    if (label !== lastGroup) {
      items.push({ type: 'separator', id: `sep:${label}`, label })
      lastGroup = label
    }
    items.push({
      id: model.id,
      modelId: model.id,
      label: model.name,
      description: model.family,
      ...(model.id === active ? { statusIconId: 'check' } : {}),
    })
  }
  return items
}

async function pickGroup(
  quickInput: IQuickInputService,
  groups: readonly AiProviderGroup[],
): Promise<AiProviderGroup | undefined> {
  if (groups.length === 0) return undefined
  if (groups.length === 1) return groups[0]
  const items = groups.map((g) => ({
    id: groupKey(g),
    label: groupKey(g),
    ...(g.baseUrl !== undefined ? { description: g.baseUrl } : {}),
  }))
  const picked = await quickInput.pick(items, {
    id: 'ai.pickGroup',
    placeholder: localize('ai.pickGroup.placeholder', 'Select a provider group'),
  })
  if (!picked) return undefined
  return groups.find((g) => groupKey(g) === picked.id)
}
