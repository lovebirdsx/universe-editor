/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  The directory a session's prompt suggestions are enumerated from. A session
 *  rooted at a strict subdirectory of the open folder (the same judgement the
 *  cwd pill uses) narrows both the `@` file listing and the `#` context entries
 *  to that directory; every other case — root cwd, unknown cwd, cwd outside the
 *  folder — keeps the workspace root, so a root-scoped session behaves exactly
 *  as it did before.
 *--------------------------------------------------------------------------------------------*/

import { IUriIdentityService, URI } from '@universe-editor/platform'
import { sessionCwdScopeRel } from './session/acpSessionHistory.js'

export interface SessionScopeRoot {
  /** Directory the prompt input's file and context suggestions come from. */
  readonly root: URI
  /** True when `root` is the session's own cwd rather than the open folder. */
  readonly narrowed: boolean
}

/**
 * Resolve that directory. The root is derived from `workspaceFolder` so the
 * subdirectory inherits its scheme, authority and encoding: a remote session
 * then needs no special case for its `remote-ssh` routing, and the entries
 * built on top of it (`URI.joinPath(root, rel)`) stay shaped like the ones a
 * root-scoped session produces.
 */
export function resolveSessionScopeRoot(
  workspaceFolder: URI | undefined,
  sessionCwd: string | undefined,
  uriIdentity: IUriIdentityService | undefined,
): SessionScopeRoot | undefined {
  if (workspaceFolder === undefined) return undefined
  const rel = uriIdentity
    ? sessionCwdScopeRel(uriIdentity, workspaceFolder.fsPath, sessionCwd)
    : null
  if (rel === null) return { root: workspaceFolder, narrowed: false }
  return { root: URI.joinPath(workspaceFolder, rel), narrowed: true }
}
