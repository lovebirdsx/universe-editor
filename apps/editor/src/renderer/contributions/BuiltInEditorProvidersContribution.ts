/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  BuiltInEditorProvidersContribution — BlockStartup phase.
 *
 *  Registers all built-in editors (provider descriptor + React component) with a
 *  single `registerEditorWithComponent` call each, synchronously, before
 *  WorkspaceRestoreContribution (BlockRestore) calls _restore().
 *
 *  Why BlockStartup: the storage.get() IPC in WorkspaceRestoreContribution
 *  ._restore() resolves faster than a lazily-imported chunk would load, so a
 *  provider registered later arrives too late for deserialisation. BlockStartup
 *  contributions run synchronously as part of setPhase(Ready). React components
 *  are imported eagerly here (as BuiltInViewsContribution already does for
 *  views) — they land in the same bundle chunk, so there is no timing gap.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, type IWorkbenchContribution } from '@universe-editor/platform'
import { registerEditorWithComponent } from '../services/editor/EditorComponentRegistry.js'
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
import { ExtensionEditorInput } from '../services/editor/ExtensionEditorInput.js'
import { CustomEditorInput } from '../services/editor/CustomEditorInput.js'
import { WebviewDiffInput } from '../services/editor/WebviewDiffInput.js'
import { SchemaViewerInput } from '../services/editor/SchemaViewerInput.js'
import { StartupPerformanceInput } from '../services/editor/StartupPerformanceInput.js'
import { TerminalEditorInput } from '../services/editor/TerminalEditorInput.js'
import { UntitledEditorInput } from '../services/editor/UntitledEditorInput.js'
import { WelcomeEditorInput } from '../services/editor/WelcomeEditorInput.js'
import { GitGraphEditorInput } from '../services/editor/GitGraphEditorInput.js'
import { PerforceGraphEditorInput } from '../services/editor/PerforceGraphEditorInput.js'
import { SwarmReviewEditorInput } from '../services/editor/SwarmReviewEditorInput.js'
import { SwarmDiffEditorInput } from '../services/editor/SwarmDiffEditorInput.js'
import { type EditorComponent } from '../services/editor/EditorComponentRegistry.js'
import { SettingsEditor } from '../workbench/preferences/SettingsEditor.js'
import { AiSettingsEditor } from '../workbench/ai/AiSettingsEditor.js'
import { KeybindingsEditor } from '../workbench/keybindings/KeybindingsEditor.js'
import { WelcomeEditor } from '../workbench/editor/WelcomeEditor.js'
import { FileEditor } from '../workbench/editor/FileEditor.js'
import { DiffEditor } from '../workbench/editor/DiffEditor.js'
import { MergeEditor } from '../workbench/editor/MergeEditor.js'
import { MarkdownPreviewEditor } from '../workbench/editor/MarkdownPreviewEditor.js'
import { ImageEditor } from '../workbench/editor/ImageEditor.js'
import { ReleaseNotesEditor } from '../workbench/editor/ReleaseNotesEditor.js'
import { StartupPerformanceEditor } from '../workbench/editor/StartupPerformanceEditor.js'
import { DocEditor } from '../workbench/editor/DocEditor.js'
import { TerminalEditorView } from '../workbench/editor/TerminalEditorView.js'
import { GitGraphEditor } from '../workbench/gitGraph/GitGraphEditor.js'
import { PerforceGraphEditor } from '../workbench/perforceGraph/PerforceGraphEditor.js'
import { SwarmReviewEditor } from '../workbench/swarm/SwarmReviewEditor.js'
import { SwarmDiffEditor } from '../workbench/swarm/SwarmDiffEditor.js'
import { ExtensionEditor } from '../workbench/extensions/ExtensionEditor.js'
import { CustomEditorHost } from '../workbench/editor/CustomEditorHost.js'

/** Some editors typed with their own input carry a stricter prop than the
 * registry's `{ input: IEditorInput }`; cast at the binding site. */
const asEditor = (c: unknown): EditorComponent => c as EditorComponent

export class BuiltInEditorProvidersContribution
  extends Disposable
  implements IWorkbenchContribution
{
  constructor() {
    super()
    this._register(
      registerEditorWithComponent(
        { typeId: WelcomeEditorInput.TYPE_ID, deserialize: () => WelcomeEditorInput.deserialize() },
        WelcomeEditor,
      ),
    )
    this._register(
      registerEditorWithComponent(
        {
          typeId: SettingsEditorInput.TYPE_ID,
          deserialize: () => SettingsEditorInput.deserialize(),
        },
        asEditor(SettingsEditor),
      ),
    )
    this._register(
      registerEditorWithComponent(
        {
          typeId: AiSettingsEditorInput.TYPE_ID,
          deserialize: () => AiSettingsEditorInput.deserialize(),
        },
        asEditor(AiSettingsEditor),
      ),
    )
    this._register(
      registerEditorWithComponent(
        {
          typeId: ExtensionEditorInput.TYPE_ID,
          deserialize: (data) => ExtensionEditorInput.deserialize(data as string),
        },
        ExtensionEditor,
      ),
    )
    this._register(
      registerEditorWithComponent(
        {
          typeId: CustomEditorInput.TYPE_ID,
          deserialize: (data) => CustomEditorInput.deserialize(data),
        },
        CustomEditorHost,
      ),
    )
    // Transient like DiffEditorInput — holds the two sides' bytes in memory (a
    // Git HEAD blob / Perforce have-revision has no on-disk file), so no
    // deserialize: a webview diff tab is dropped on window restore. Shares the
    // CustomEditorHost component with customEditor.
    this._register(
      registerEditorWithComponent(
        { typeId: WebviewDiffInput.TYPE_ID, componentKey: 'customEditor' },
        CustomEditorHost,
      ),
    )
    // Transient read-only schema viewer — no deserialize: it carries in-memory
    // schema text that isn't persisted, so a restored window simply drops it.
    // Rendered by the file editor.
    this._register(
      registerEditorWithComponent(
        { typeId: SchemaViewerInput.TYPE_ID, componentKey: 'file' },
        FileEditor,
      ),
    )
    this._register(
      registerEditorWithComponent(
        {
          typeId: KeybindingsEditorInput.TYPE_ID,
          deserialize: () => KeybindingsEditorInput.deserialize(),
        },
        asEditor(KeybindingsEditor),
      ),
    )
    this._register(
      registerEditorWithComponent(
        {
          typeId: FileEditorInput.TYPE_ID,
          deserialize: (data, accessor) => FileEditorInput.deserialize(data, accessor),
        },
        FileEditor,
      ),
    )
    this._register(
      registerEditorWithComponent(
        {
          typeId: UntitledEditorInput.TYPE_ID,
          componentKey: 'file',
          deserialize: (data) => UntitledEditorInput.deserialize(data),
        },
        FileEditor,
      ),
    )
    this._register(
      registerEditorWithComponent(
        {
          typeId: DiffEditorInput.TYPE_ID,
          deserialize: (data) => DiffEditorInput.deserialize(data),
        },
        DiffEditor,
      ),
    )
    this._register(registerEditorWithComponent({ typeId: MergeEditorInput.TYPE_ID }, MergeEditor))
    this._register(
      registerEditorWithComponent(
        {
          typeId: MarkdownPreviewInput.TYPE_ID,
          deserialize: (data) => MarkdownPreviewInput.deserialize(data),
        },
        MarkdownPreviewEditor,
      ),
    )
    this._register(
      registerEditorWithComponent(
        {
          typeId: ImageEditorInput.TYPE_ID,
          deserialize: (data) => ImageEditorInput.deserialize(data),
        },
        ImageEditor,
      ),
    )
    this._register(
      registerEditorWithComponent(
        {
          typeId: ReleaseNotesInput.TYPE_ID,
          deserialize: (data) => ReleaseNotesInput.deserialize(data),
        },
        ReleaseNotesEditor,
      ),
    )
    this._register(
      registerEditorWithComponent(
        { typeId: DocEditorInput.TYPE_ID, deserialize: (data) => DocEditorInput.deserialize(data) },
        DocEditor,
      ),
    )
    this._register(
      registerEditorWithComponent(
        {
          typeId: StartupPerformanceInput.TYPE_ID,
          deserialize: () => StartupPerformanceInput.deserialize(),
        },
        StartupPerformanceEditor,
      ),
    )
    this._register(
      registerEditorWithComponent(
        {
          typeId: TerminalEditorInput.TYPE_ID,
          deserialize: (data, accessor) => TerminalEditorInput.deserialize(data, accessor),
        },
        asEditor(TerminalEditorView),
      ),
    )
    this._register(
      registerEditorWithComponent(
        {
          typeId: GitGraphEditorInput.TYPE_ID,
          deserialize: () => GitGraphEditorInput.deserialize(),
        },
        GitGraphEditor,
      ),
    )
    this._register(
      registerEditorWithComponent(
        {
          typeId: PerforceGraphEditorInput.TYPE_ID,
          deserialize: () => PerforceGraphEditorInput.deserialize(),
        },
        PerforceGraphEditor,
      ),
    )
    this._register(
      registerEditorWithComponent(
        {
          typeId: SwarmReviewEditorInput.TYPE_ID,
          deserialize: (data) => SwarmReviewEditorInput.deserialize(data),
        },
        SwarmReviewEditor,
      ),
    )
    this._register(
      registerEditorWithComponent({ typeId: SwarmDiffEditorInput.TYPE_ID }, SwarmDiffEditor),
    )
  }
}
