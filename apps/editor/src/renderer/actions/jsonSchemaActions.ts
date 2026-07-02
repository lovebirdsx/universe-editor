/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  ShowJsonSchemaAction — editor-title action shown only for JSON files that have
 *  a registered schema (`activeEditorHasJsonSchema`). Opens the resolved schema
 *  in a read-only viewer tab, mirroring VSCode's "show JSON schema" affordance.
 *--------------------------------------------------------------------------------------------*/

import {
  Action2,
  IEditorGroupsService,
  ILoggerService,
  MenuId,
  localize,
  type ServicesAccessor,
} from '@universe-editor/platform'
import { FileEditorInput } from '../services/editor/FileEditorInput.js'
import { openInLockAwareGroup } from '../services/editor/openInLockAwareGroup.js'
import { SchemaViewerInput } from '../services/editor/SchemaViewerInput.js'
import { matchSchemasForUri } from '../services/preferences/schemaMatch.js'
import { basenameOfResource } from '../workbench/files/resourceInfo.js'

const PRECONDITION = 'activeEditorLanguageId == json && activeEditorHasJsonSchema'

export class ShowJsonSchemaAction extends Action2 {
  static readonly ID = 'workbench.action.json.showSchema'

  constructor() {
    super({
      id: ShowJsonSchemaAction.ID,
      title: localize('action.json.showSchema.title', 'Show JSON Schema'),
      category: localize('command.category.json', 'JSON'),
      icon: 'json-schema',
      precondition: PRECONDITION,
      menu: [{ id: MenuId.EditorTitle, group: 'navigation', when: PRECONDITION }],
      f1: true,
    })
  }

  override run(accessor: ServicesAccessor): void {
    const groups = accessor.get(IEditorGroupsService)
    const active = groups.activeGroup.activeEditor
    if (!(active instanceof FileEditorInput)) return

    const schemas = matchSchemasForUri(active.resource)
    if (schemas.length === 0) return

    const logger = accessor
      .get(ILoggerService)
      .createLogger({ id: 'jsonSchemas', name: 'JSON Schemas' })
    if (schemas.length > 1) {
      logger.info(
        `${schemas.length} schemas match ${active.resource.toString()}; showing the first (${
          schemas[0]!.uri
        }), others: ${schemas
          .slice(1)
          .map((s) => s.uri)
          .join(', ')}`,
      )
    }

    const name = basenameOfResource(active.resource)
    const content = JSON.stringify(schemas[0]!.schema, null, 2)
    openInLockAwareGroup(groups, new SchemaViewerInput(name, content), {
      activate: true,
      pinned: true,
    })
  }
}
