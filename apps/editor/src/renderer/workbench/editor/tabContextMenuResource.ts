/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Maps an editor tab to the resource its right-click file commands (Copy Name /
 *  Path / Relative Path, Reveal in Explorer, Open Containing Folder) should act
 *  on. For most inputs that is the input's own `resource`; for a markdown
 *  preview the tab carries a virtual `markdown-preview:` URI, so we route those
 *  commands to the underlying source `.md` file instead — otherwise the
 *  `resourceScheme == file` when-clauses hide every file command on a preview
 *  tab and the commands would have no `file:` URI to run against.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '@universe-editor/platform'
import { MarkdownPreviewInput } from '../../services/editor/MarkdownPreviewInput.js'

export function tabContextMenuResource(input: unknown): URI | null {
  if (input instanceof MarkdownPreviewInput) return input.sourceUri
  const resource = (input as { resource?: unknown }).resource
  return resource instanceof URI ? resource : null
}
