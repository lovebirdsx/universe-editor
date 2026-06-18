/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  Resolves which registered JSON schemas apply to a given file URI, replicating
 *  Monaco's fileMatch semantics: Monaco wraps every `fileMatch` pattern with a
 *  leading `**​/` before matching the normalised model URI. We mirror that here so
 *  the editor-title schema indicator agrees with what Monaco actually applies.
 *--------------------------------------------------------------------------------------------*/

import {
  JSONContributionRegistry,
  makeGlobMatcher,
  type ISchemaContribution,
  type URI,
} from '@universe-editor/platform'
import { schemaFileMatchForUri } from './schemaFileMatch.js'

/** The registered schemas whose fileMatch covers `uri` (Monaco `**​/` semantics). */
export function matchSchemasForUri(uri: URI): ISchemaContribution[] {
  const path = schemaFileMatchForUri(uri)
  return JSONContributionRegistry.getContributions().filter((c) => {
    const patterns = c.fileMatch.flatMap((p) => (p.startsWith('**/') ? [p] : [p, `**/${p}`]))
    const match = makeGlobMatcher(patterns)
    return match ? match(path) : false
  })
}
