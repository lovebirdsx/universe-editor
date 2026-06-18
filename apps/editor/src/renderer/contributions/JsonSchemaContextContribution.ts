/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Maintains the `activeEditorHasJsonSchema` context key: true when the active
 *  editor is a JSON file covered by a registered schema. Drives the editor-title
 *  "Show JSON Schema" action's visibility. Re-evaluates both when the active
 *  editor changes and when the schema registry changes — remote schemas (e.g.
 *  the claude-helper http schema) arrive asynchronously after the file opens.
 *--------------------------------------------------------------------------------------------*/

import {
  autorun,
  Disposable,
  IContextKeyService,
  IEditorService,
  IWorkbenchContribution,
  JSONContributionRegistry,
} from '@universe-editor/platform'
import { FileEditorInput } from '../services/editor/FileEditorInput.js'
import { matchSchemasForUri } from '../services/preferences/schemaMatch.js'

export class JsonSchemaContextContribution extends Disposable implements IWorkbenchContribution {
  constructor(
    @IContextKeyService contextKeyService: IContextKeyService,
    @IEditorService private readonly _editorService: IEditorService,
  ) {
    super()

    const key = contextKeyService.createKey<boolean>('activeEditorHasJsonSchema', false)
    const evaluate = () => {
      const active = this._editorService.activeEditor.get()
      const hasSchema =
        active instanceof FileEditorInput &&
        active.language === 'json' &&
        matchSchemasForUri(active.resource).length > 0
      key.set(hasSchema)
    }

    this._register(
      autorun((reader) => {
        this._editorService.activeEditor.read(reader)
        evaluate()
      }),
    )
    this._register(JSONContributionRegistry.onDidChangeContributions(evaluate))
  }
}
