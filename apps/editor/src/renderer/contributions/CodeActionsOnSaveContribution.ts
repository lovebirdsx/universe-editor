/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  CodeActionsOnSaveContribution — the `editor.codeActionsOnSave` counterpart
 *  of VSCode's CodeActionOnSaveParticipant. On save, resolves the configured
 *  source-action kinds (e.g. `source.organizeImports`, `source.fixAll`), asks
 *  monaco's code-action registry for matching actions, and applies their edits
 *  to the model before FileEditorInput reads it for the write.
 *
 *  Registered on the SaveParticipant static registry (no live editor needed,
 *  so Save All works on models without a mounted editor). Monaco's internal
 *  `getCodeActions` does provider selection + kind filtering; we apply the
 *  returned edits directly via pushEditOperations instead of monaco's
 *  `applyCodeAction` — our code-action pipeline drops `command` (see
 *  codeActionsToMonaco) and the edits are already monaco WorkspaceEdits.
 *--------------------------------------------------------------------------------------------*/

import {
  Disposable,
  IConfigurationService,
  ILoggerService,
  type ILogger,
  type IWorkbenchContribution,
} from '@universe-editor/platform'
import { MonacoLoader, type monaco } from '../workbench/editor/monaco/MonacoLoader.js'
import { SaveParticipant, type SaveReason } from '../services/extensions/SaveParticipant.js'
import { resolveCodeActionsOnSave } from '../services/extensions/codeActionsOnSaveSettings.js'
import type { CodeActionsOnSaveSetting } from '../services/extensions/codeActionsOnSaveSettings.js'

const SETTING_KEY = 'editor.codeActionsOnSave'

export class CodeActionsOnSaveContribution extends Disposable implements IWorkbenchContribution {
  private readonly _logger: ILogger

  constructor(
    @IConfigurationService private readonly _config: IConfigurationService,
    @ILoggerService loggerService: ILoggerService,
  ) {
    super()
    this._logger = loggerService.createLogger({
      id: 'codeActionsOnSave',
      name: 'Code Actions On Save',
    })
    this._register(SaveParticipant.register((model, reason) => this._participate(model, reason)))
  }

  private async _participate(model: monaco.editor.ITextModel, reason: SaveReason): Promise<void> {
    const setting = this._config.get<CodeActionsOnSaveSetting>(SETTING_KEY)
    const { include, excludes } = resolveCodeActionsOnSave(setting, reason)
    if (include.length === 0) return

    // Monaco must be live for the code-action registry; a save before that
    // (or in a test) just skips the actions rather than blocking the write.
    const monacoNs = MonacoLoader.peek()
    if (!monacoNs) return

    const started = Date.now()
    this._logger.debug(
      `running ${include.length} kind(s) [${include.join(', ')}] for ${model.uri.toString()} (reason=${reason})`,
    )

    const [{ HierarchicalKind }, { CancellationToken }] = await Promise.all([
      import('monaco-editor/esm/vs/base/common/hierarchicalKind.js'),
      import('monaco-editor/esm/vs/base/common/cancellation.js'),
    ])
    const lf = await MonacoLoader.getLanguageFeaturesService()

    for (const kind of include) {
      if (model.isDisposed()) return
      try {
        await this._runKind(
          lf.codeActionProvider,
          model,
          new HierarchicalKind(kind),
          excludes.map((e) => new HierarchicalKind(e)),
          CancellationToken.None,
        )
      } catch (err) {
        // One failing kind must not block the remaining kinds or the save.
        this._logger.warn(`kind "${kind}" failed for ${model.uri.toString()}`, err)
      }
    }
    this._logger.debug(`done in ${Date.now() - started}ms`)
  }

  private async _runKind(
    registry: unknown,
    model: monaco.editor.ITextModel,
    kind: unknown,
    excludes: readonly unknown[],
    token: unknown,
  ): Promise<void> {
    const { getCodeActions } =
      await import('monaco-editor/esm/vs/editor/contrib/codeAction/browser/codeAction.js')
    const set = await getCodeActions(
      registry,
      model,
      model.getFullModelRange(),
      {
        type: 2, // monaco.languages.CodeActionTriggerType.Auto
        triggerAction: 'save participants', // monaco CodeActionTriggerSource.OnSave
        filter: { include: kind, excludes, includeSourceActions: true },
      },
      undefined,
      token,
    )
    try {
      for (const item of set.validActions) {
        if (model.isDisposed()) return
        this._applyEdit(model, item.action)
      }
    } finally {
      set.dispose()
    }
  }

  private _applyEdit(model: monaco.editor.ITextModel, action: monaco.languages.CodeAction): void {
    const edit = action.edit
    if (!edit) return
    const ops: monaco.editor.IIdentifiedSingleEditOperation[] = []
    for (const e of edit.edits) {
      const textEdit = (e as monaco.languages.IWorkspaceTextEdit).textEdit
      const resource = (e as monaco.languages.IWorkspaceTextEdit).resource
      if (!textEdit || !resource) continue // skip file operations (create/rename/delete)
      if (resource.toString() !== model.uri.toString()) continue // single-model save
      ops.push({ range: textEdit.range, text: textEdit.text, forceMoveMarkers: true })
    }
    if (ops.length === 0) return
    this._logger.debug(`applying "${action.title}" (${ops.length} edit(s))`)
    model.pushEditOperations(null, ops, () => null)
  }
}
