/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Builds a Monaco JSON `fileMatch` pattern that targets exactly one file, so our
 *  strict settings/keybindings/aiSettings schemas only validate our own files —
 *  not any unrelated same-named file (e.g. ~/.claude/settings.json) the user opens.
 *--------------------------------------------------------------------------------------------*/

import type { URI } from '@universe-editor/platform'

/**
 * Monaco wraps each `fileMatch` pattern in `**​/<pattern>` and tests it against
 * the normalized model URI string — `URI.toString(true)`, which lower-cases the
 * Windows drive letter, decodes (skipEncoding), and uses forward slashes
 * (e.g. `file:///c:/Users/admin/AppData/Roaming/Universe Editor/settings.json`).
 *
 * So we emit the decoded path with a lower-cased drive and no leading slash,
 * letting Monaco's own `**​/` absorb the `file:///` scheme prefix. The result
 * matches that one resource and nothing else.
 */
export function schemaFileMatchForUri(uri: URI): string {
  const lowerDrive = uri.path.replace(/^\/([A-Za-z]):/, (_m, d: string) => `/${d.toLowerCase()}:`)
  return lowerDrive.startsWith('/') ? lowerDrive.slice(1) : lowerDrive
}
