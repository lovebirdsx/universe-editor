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
import { MergeEditorInput } from '../services/editor/MergeEditorInput.js'
import { DocEditorInput } from '../services/editor/DocEditorInput.js'
import { FileEditorInput } from '../services/editor/FileEditorInput.js'
import { KeybindingsEditorInput } from '../services/editor/KeybindingsEditorInput.js'
import { MarkdownPreviewInput } from '../services/editor/MarkdownPreviewInput.js'
import { ImageEditorInput } from '../services/editor/ImageEditorInput.js'
import { ReleaseNotesInput } from '../services/editor/ReleaseNotesInput.js'
import { SettingsEditorInput } from '../services/editor/SettingsEditorInput.js'
import { AiSettingsEditorInput } from '../services/editor/AiSettingsEditorInput.js'
import { SchemaViewerInput } from '../services/editor/SchemaViewerInput.js'
import { StartupPerformanceInput } from '../services/editor/StartupPerformanceInput.js'
import { TerminalEditorInput } from '../services/editor/TerminalEditorInput.js'
import { UntitledEditorInput } from '../services/editor/UntitledEditorInput.js'
import { WelcomeEditorInput } from '../services/editor/WelcomeEditorInput.js'
import { GitGraphEditorInput } from '../services/editor/GitGraphEditorInput.js'

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
        typeId: AiSettingsEditorInput.TYPE_ID,
        componentKey: 'aiSettings',
        deserialize: () => AiSettingsEditorInput.deserialize(),
      }),
    )
    // Transient read-only schema viewer — no deserialize: it carries in-memory
    // schema text that isn't persisted, so a restored window simply drops it.
    this._register(
      EditorRegistry.registerEditorProvider({
        typeId: SchemaViewerInput.TYPE_ID,
        componentKey: 'file',
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
        typeId: MergeEditorInput.TYPE_ID,
        componentKey: 'merge',
      }),
    )
    this._register(
      EditorRegistry.registerEditorProvider({
        typeId: MarkdownPreviewInput.TYPE_ID,
        componentKey: 'markdown.preview',
        deserialize: (data) => MarkdownPreviewInput.deserialize(data),
      }),
    )
    this._register(
      EditorRegistry.registerEditorProvider({
        typeId: ImageEditorInput.TYPE_ID,
        componentKey: 'image',
        deserialize: (data) => ImageEditorInput.deserialize(data),
      }),
    )
    this._register(
      EditorRegistry.registerEditorProvider({
        typeId: ReleaseNotesInput.TYPE_ID,
        componentKey: 'releaseNotes',
        deserialize: (data) => ReleaseNotesInput.deserialize(data),
      }),
    )
    this._register(
      EditorRegistry.registerEditorProvider({
        typeId: DocEditorInput.TYPE_ID,
        componentKey: 'doc',
        deserialize: (data) => DocEditorInput.deserialize(data),
      }),
    )
    this._register(
      EditorRegistry.registerEditorProvider({
        typeId: StartupPerformanceInput.TYPE_ID,
        componentKey: 'startupPerformance',
        deserialize: () => StartupPerformanceInput.deserialize(),
      }),
    )
    this._register(
      EditorRegistry.registerEditorProvider({
        typeId: TerminalEditorInput.TYPE_ID,
        componentKey: 'terminal.editor',
        deserialize: (data, accessor) => TerminalEditorInput.deserialize(data, accessor),
      }),
    )
    this._register(
      EditorRegistry.registerEditorProvider({
        typeId: GitGraphEditorInput.TYPE_ID,
        componentKey: 'gitGraph',
        deserialize: () => GitGraphEditorInput.deserialize(),
      }),
    )
  }
}
