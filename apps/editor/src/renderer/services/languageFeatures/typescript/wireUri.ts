/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  LSP wire types (vscode-languageserver-types) carry URIs as bare strings, so the
 *  host↔renderer codec's $mid URI transformer never sees them — a remote extension
 *  host's `file:///home/...` would reach the renderer as a local file URI. The
 *  LSP→Monaco conversion layer interprets wire URI strings against the host's URI
 *  space instead. A window owns exactly one extension host (remote mode rides the
 *  same HostConnection path), so the remote authority is a window-lifetime constant
 *  and module ambient state covers every converter consumer at once.
 *--------------------------------------------------------------------------------------------*/

import { REMOTE_SCHEME } from '@universe-editor/platform'
import { type monaco } from '../../../workbench/editor/monaco/MonacoLoader.js'

let remoteAuthority: string | undefined

export function setWireUriRemoteAuthority(authority: string | undefined): void {
  remoteAuthority = authority
}

/**
 * Parse a wire-source URI string in the extension host's URI space: under a remote
 * workspace, `file://` strings name remote files and are rebuilt as REMOTE_SCHEME
 * URIs with the window's authority. Everything else (offline window, untitled,
 * https…) parses as-is.
 */
export function parseWireUri(monacoNs: typeof monaco, raw: string): monaco.Uri {
  const parsed = monacoNs.Uri.parse(raw)
  if (remoteAuthority === undefined || parsed.scheme !== 'file') return parsed
  return monacoNs.Uri.from({
    scheme: REMOTE_SCHEME,
    authority: remoteAuthority,
    path: parsed.path,
    query: parsed.query,
    fragment: parsed.fragment,
  })
}
