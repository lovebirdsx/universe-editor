/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Change Language Mode — VSCode parity (workbench.action.editor.changeLanguageMode,
 *  Ctrl+K M). Shows a QuickPick of every registered language plus an "Auto
 *  Detect" entry that re-derives the language from the file name.
 *--------------------------------------------------------------------------------------------*/

import {
  Action2,
  IEditorService,
  IQuickInputService,
  localize,
  localize2,
  type QuickPickInput,
  type ServicesAccessor,
} from '@universe-editor/platform'
import { FileEditorInput } from '../services/editor/FileEditorInput.js'
import { languageForResource } from '../workbench/files/resourceLanguage.js'
import { displayNameFromAliases } from '../workbench/files/languageDisplay.js'
import { MonacoLoader } from '../workbench/editor/monaco/MonacoLoader.js'

// Sentinel id for the "Auto Detect" row; must never collide with a language id.
const AUTO_DETECT_ID = '$auto$'

export function buildLanguagePickItems(
  languages: readonly { id: string; aliases?: readonly string[] }[],
  currentLanguageId: string,
): QuickPickInput[] {
  const seen = new Set<string>()
  const items: { id: string; label: string; description: string }[] = []
  for (const language of languages) {
    if (seen.has(language.id)) continue
    seen.add(language.id)
    const description =
      language.id === currentLanguageId
        ? `${language.id} — ${localize('languageMode.configured', 'Configured Language')}`
        : language.id
    items.push({
      id: language.id,
      label: displayNameFromAliases(language.id, language.aliases),
      description,
    })
  }
  items.sort((a, b) => a.label.localeCompare(b.label))
  return [
    { id: AUTO_DETECT_ID, label: localize('languageMode.autoDetect', 'Auto Detect') },
    { type: 'separator', id: 'languages' },
    ...items,
  ]
}

export class ChangeLanguageModeAction extends Action2 {
  static readonly ID = 'workbench.action.editor.changeLanguageMode'
  constructor() {
    super({
      id: ChangeLanguageModeAction.ID,
      title: localize2('action.changeLanguageMode', 'Change Language Mode'),
      category: localize2('command.category.editor', 'Editor'),
      keybinding: { primary: 'ctrl+k m' },
      f1: true,
    })
  }
  override async run(accessor: ServicesAccessor): Promise<void> {
    // Snapshot every service before the first await (the accessor dies there).
    const editorService = accessor.get(IEditorService)
    const quickInputService = accessor.get(IQuickInputService)
    const input = editorService.activeEditor.get()
    if (!(input instanceof FileEditorInput)) return
    await MonacoLoader.ensureInitialized()
    const model = input.peekModel() ?? (await input.resolveModel())
    const monaco = MonacoLoader.get()
    const currentLanguageId = model.getLanguageId()
    const picked = await quickInputService.pick(
      buildLanguagePickItems(monaco.languages.getLanguages(), currentLanguageId),
      {
        placeholder: localize('languageMode.placeholder', 'Select Language Mode'),
        matchOnDescription: true,
        activeItemId: currentLanguageId,
      },
    )
    if (!picked) return
    const target = picked.id === AUTO_DETECT_ID ? languageForResource(input.resource) : picked.id
    monaco.editor.setModelLanguage(model, target)
  }
}
