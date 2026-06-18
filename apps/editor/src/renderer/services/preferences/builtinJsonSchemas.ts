/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  Built-in JSON schema associations — the core-code source of the JSON schema
 *  mechanism (alongside extension `contributes.jsonValidation` and the user
 *  `json.schemas` setting). Add an entry here to ship a schema for a new
 *  built-in JSON file type; JsonSchemaAssociationsContribution registers each
 *  one with JSONContributionRegistry on startup.
 *--------------------------------------------------------------------------------------------*/

import type { IJSONSchema } from '@universe-editor/platform'

export interface IBuiltinJsonSchema {
  /** Stable key used to build the schema's registry uri. */
  key: string
  /** Monaco `fileMatch` globs (e.g. `**​/*.entity.json`). */
  fileMatch: string[]
  schema: IJSONSchema
}

// Intentionally empty for now. Built-in entries belong here only when a schema
// must live in core rather than ship via an extension (the jsonValidation path,
// which also supports remote http urls). Example shape:
//
//   { key: 'level', fileMatch: ['**​/*.level.json'], schema: { type: 'object', ... } }
export const BUILTIN_JSON_SCHEMAS: readonly IBuiltinJsonSchema[] = []
