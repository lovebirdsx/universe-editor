/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Inline-completion commands: manually trigger a suggestion (Alt+\), toggle the
 *  feature on/off, and pick the dedicated completion model. The completion model
 *  is persisted separately from the chat "active model" (it may be a smaller,
 *  faster model), so this picker writes through IInlineCompletionService.
 *--------------------------------------------------------------------------------------------*/

import {
  Action2,
  IAiModelService,
  IEditorGroupsService,
  IInstantiationService,
  INotificationService,
  IQuickInputService,
  KeybindingWeight,
  Severity,
  localize,
  type AiModelMetadata,
  type IQuickPickItem,
  type QuickPickInput,
  type ServicesAccessor,
} from '@universe-editor/platform'
import { FileEditorInput } from '../services/editor/FileEditorInput.js'
import { FileEditorRegistry } from '../services/editor/FileEditorRegistry.js'
import { IInlineCompletionService } from '../services/ai/InlineCompletionService.js'

const CATEGORY = localize('command.category.ai', 'AI')

interface ModelPickItem extends IQuickPickItem {
  readonly modelId?: string
}

export class TriggerInlineCompletionAction extends Action2 {
  static readonly ID = 'ai.inlineCompletion.trigger'
  constructor() {
    super({
      id: TriggerInlineCompletionAction.ID,
      title: localize('action.ai.inlineCompletion.trigger', 'Trigger Inline Completion'),
      category: CATEGORY,
      keybinding: { primary: 'alt+\\', when: 'editorTextFocus' },
      f1: true,
    })
  }
  override async run(accessor: ServicesAccessor): Promise<void> {
    // The accessor is only valid synchronously, so resolve every service up
    // front — anything fetched after an `await` would throw.
    const inline = accessor.get(IInlineCompletionService)
    const groups = accessor.get(IEditorGroupsService)
    const notification = accessor.get(INotificationService)
    const instantiation = accessor.get(IInstantiationService)

    // First-run guidance: a manual trigger with no completion model configured
    // walks the user to the picker instead of silently doing nothing.
    if (!(await inline.getModelId())) {
      await notification.prompt(
        Severity.Info,
        localize(
          'ai.inlineCompletion.noModel',
          'No model is configured for inline completions. Pick one to get started.',
        ),
        [
          {
            label: localize('ai.inlineCompletion.pickNow', 'Select Model'),
            run: () => {
              void instantiation.invokeFunction((a) => new PickInlineCompletionModelAction().run(a))
            },
          },
        ],
      )
      return
    }

    const group = groups.activeGroup
    const active = group.activeEditor
    if (!(active instanceof FileEditorInput)) return
    const editor = FileEditorRegistry.get(active, group.id)
    editor?.trigger('keyboard', 'editor.action.inlineSuggest.trigger', undefined)
  }
}

export class CommitInlineCompletionAction extends Action2 {
  static readonly ID = 'ai.inlineCompletion.commit'
  constructor() {
    super({
      id: CommitInlineCompletionAction.ID,
      title: localize('action.ai.inlineCompletion.commit', 'Accept Inline Completion'),
      category: CATEGORY,
      // Claim Tab while ghost text is visible. Monaco confines its own
      // inlineSuggestionVisible key to the editor's scoped context-key service
      // and, with editContext: true, can't be relied on to commit on Tab — so we
      // run the commit command ourselves and must outrank every other Tab binding
      // that could be active in the editor. That includes extension-contributed
      // Tab handlers (e.g. markdown.editing.onTab at ExternalExtension=400), not
      // just Monaco's bridged default — hence ExternalExtension + 1. It stays
      // below User (1000) so a user override still wins. The suggest-widget guard
      // keeps Tab accepting an open IntelliSense pick first.
      keybinding: {
        primary: 'tab',
        weight: KeybindingWeight.ExternalExtension + 1,
        when: 'inlineSuggestionVisible && editorTextFocus && !suggestWidgetVisible',
      },
    })
  }
  override run(accessor: ServicesAccessor): void {
    const groups = accessor.get(IEditorGroupsService)
    const group = groups.activeGroup
    const active = group.activeEditor
    if (!(active instanceof FileEditorInput)) return
    const editor = FileEditorRegistry.get(active, group.id)
    editor?.trigger('keyboard', 'editor.action.inlineSuggest.commit', undefined)
  }
}

export class ToggleInlineCompletionAction extends Action2 {
  static readonly ID = 'ai.inlineCompletion.toggle'
  constructor() {
    super({
      id: ToggleInlineCompletionAction.ID,
      title: localize('action.ai.inlineCompletion.toggle', 'Toggle Inline Completions'),
      category: CATEGORY,
      f1: true,
    })
  }
  override run(accessor: ServicesAccessor): void {
    const inline = accessor.get(IInlineCompletionService)
    inline.toggleEnabled()
    accessor
      .get(INotificationService)
      .status(
        inline.enabled
          ? localize('ai.inlineCompletion.enabled', 'Inline completions enabled.')
          : localize('ai.inlineCompletion.disabled', 'Inline completions disabled.'),
      )
  }
}

export class PickInlineCompletionModelAction extends Action2 {
  static readonly ID = 'ai.inlineCompletion.pickModel'
  constructor() {
    super({
      id: PickInlineCompletionModelAction.ID,
      title: localize('action.ai.inlineCompletion.pickModel', 'Select Inline Completion Model'),
      category: CATEGORY,
      f1: true,
    })
  }
  override async run(accessor: ServicesAccessor): Promise<void> {
    const quickInput = accessor.get(IQuickInputService)
    const aiModel = accessor.get(IAiModelService)
    const inline = accessor.get(IInlineCompletionService)

    const [models, current] = await Promise.all([aiModel.getModels(), inline.getModelId()])
    const picked = await quickInput.pick(buildModelPickItems(models, current), {
      id: 'ai.inlineCompletion.pickModel',
      placeholder: localize(
        'ai.inlineCompletion.pickModel.placeholder',
        'Select the model used for inline completions',
      ),
      matchOnDescription: true,
    })
    if (!picked) return
    await inline.setModelId(picked.modelId)
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
