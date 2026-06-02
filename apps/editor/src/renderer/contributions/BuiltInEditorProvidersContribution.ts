/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  BuiltInEditorProvidersContribution — BlockStartup phase.
 *
 *  Registers all built-in EditorInput providers with EditorRegistry synchronously,
 *  before WorkspaceRestoreContribution (BlockRestore) calls _restore().
 *
 *  Why this must be BlockStartup, not module-level in EditorArea.tsx:
 *    EditorArea.tsx is part of the Workbench dynamic chunk loaded via
 *    `await import('./workbench/Workbench.js')` in main.tsx, which happens
 *    AFTER lifecycle.setPhase(LifecyclePhase.Ready). The storage.get() IPC call
 *    in WorkspaceRestoreContribution._restore() resolves faster than the Workbench
 *    chunk loads, so any provider registered only in EditorArea.tsx arrives too
 *    late for deserialisation. BlockStartup contributions run synchronously as
 *    part of setPhase(Ready), before BlockRestore contributions are constructed.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, EditorRegistry, type IWorkbenchContribution } from '@universe-editor/platform'
import { DiffEditorInput } from '../services/editor/DiffEditorInput.js'
import { FileEditorInput } from '../services/editor/FileEditorInput.js'
import { KeybindingsEditorInput } from '../services/editor/KeybindingsEditorInput.js'
import { MarkdownPreviewInput } from '../services/editor/MarkdownPreviewInput.js'
import { SettingsEditorInput } from '../services/editor/SettingsEditorInput.js'
import { UntitledEditorInput } from '../services/editor/UntitledEditorInput.js'
import { WelcomeEditorInput } from '../services/editor/WelcomeEditorInput.js'

export class BuiltInEditorProvidersContribution
  extends Disposable
  implements IWorkbenchContribution
{
  constructor() {
    super()
    this._register(
      EditorRegistry.registerEditorProvider({
        typeId: WelcomeEditorInput.TYPE_ID,
        componentKey: 'welcome',
        deserialize: () => WelcomeEditorInput.deserialize(),
      }),
    )
    this._register(
      EditorRegistry.registerEditorProvider({
        typeId: SettingsEditorInput.TYPE_ID,
        componentKey: 'settings',
        deserialize: () => SettingsEditorInput.deserialize(),
      }),
    )
    this._register(
      EditorRegistry.registerEditorProvider({
        typeId: KeybindingsEditorInput.TYPE_ID,
        componentKey: 'keybindings',
        deserialize: () => KeybindingsEditorInput.deserialize(),
      }),
    )
    this._register(
      EditorRegistry.registerEditorProvider({
        typeId: FileEditorInput.TYPE_ID,
        componentKey: 'file',
        deserialize: (data, accessor) => FileEditorInput.deserialize(data, accessor),
      }),
    )
    this._register(
      EditorRegistry.registerEditorProvider({
        typeId: UntitledEditorInput.TYPE_ID,
        componentKey: 'file',
        deserialize: (data) => UntitledEditorInput.deserialize(data),
      }),
    )
    this._register(
      EditorRegistry.registerEditorProvider({
        typeId: DiffEditorInput.TYPE_ID,
        componentKey: 'diff',
      }),
    )
    this._register(
      EditorRegistry.registerEditorProvider({
        typeId: MarkdownPreviewInput.TYPE_ID,
        componentKey: 'markdown.preview',
        deserialize: (data) => MarkdownPreviewInput.deserialize(data),
      }),
    )
  }
}
