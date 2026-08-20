/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Remote resource path helpers. With the v2 protocol the server performs URI
 *  translation inside its IPC codec (remote-ssh <-> file), so the client sends
 *  `remote-ssh://<authority>/<path>` resources verbatim and receives remote-ssh
 *  URIs back — there is no toWire/fromWire on the client anymore.
 *--------------------------------------------------------------------------------------------*/

import { normalizeFsPath } from '../base/path.js'
import { URI } from '../base/uri.js'
import {
  REMOTE_SCHEME,
  WSL_AUTHORITY_PREFIX,
  isWslAuthority,
  isValidWslDistroName,
  normalizeRemoteAuthority,
} from './remoteProtocol.js'

/**
 * A server-side filesystem path string → remote-ssh URI. This is the ONE
 * documented exception to "paths travel as URIs": watcher event paths are server
 * fsPath strings by design (they never go through the codec's URI transformer),
 * so the client reattaches the authority here.
 * Normalizes backslashes to forward slashes and guarantees a leading slash.
 */
export function remoteFsPathToUri(fsPath: string, authority: string): URI {
  let path = fsPath.replace(/\\/g, '/')
  if (!path.startsWith('/')) path = `/${path}`
  return URI.from({ scheme: REMOTE_SCHEME, authority, path })
}

/**
 * A provider-host filesystem path string → workspace resource URI. SCM wire
 * contracts carry bare fs-path strings (the extension host only knows its own
 * host's paths); the renderer reattaches the workspace's remote authority here.
 * `remoteAuthority` is the current workspace's authority (undefined for a
 * local workspace), e.g. from `useRemoteAuthority()`.
 */
export function fsPathToWorkspaceUri(fsPath: string, remoteAuthority: string | undefined): URI {
  return remoteAuthority ? remoteFsPathToUri(fsPath, remoteAuthority) : URI.file(fsPath)
}

/**
 * A tool/agent/terminal-reported absolute path string → workspace resource URI.
 * Unlike {@link fsPathToWorkspaceUri} — which takes an authority and always
 * attaches it — this takes the workspace folder URI and only inherits its
 * scheme/authority when the folder is non-`file` (remote) and the path is
 * absolute. The reporting tool/agent/terminal runs on the workspace host, so any
 * absolute path — POSIX or Windows drive-letter (a Windows remote host) — is a
 * host path and inherits the folder's scheme/authority. A Windows drive path is
 * normalized to the leading-slash URI form (`C:\foo` → `/C:/foo`), matching
 * {@link remoteFsPathToUri}. Relative paths and local workspaces fall back to
 * `URI.file`.
 */
export function absolutePathToWorkspaceUri(absolutePath: string, folder: URI | undefined): URI {
  const isAbsolute = absolutePath.startsWith('/') || /^[A-Za-z]:[/\\]/.test(absolutePath)
  if (folder && folder.scheme !== 'file' && isAbsolute) {
    const normalized = normalizeFsPath(absolutePath)
    return folder.with({
      path: normalized.startsWith('/') ? normalized : `/${normalized}`,
      query: '',
      fragment: '',
    })
  }
  return URI.file(absolutePath)
}

/**
 * The server-local filesystem path string for a remote resource. A remote-ssh
 * URI encodes a Windows drive letter with a leading slash (`/C:/...`); `URI.fsPath`
 * strips that leading slash (and is a no-op for POSIX paths), so it yields the
 * server host's native path for both POSIX targets and Windows direct-mode. This
 * string is only consumed by services that take bare paths (the watcher subscribe
 * `dir`); every other surface goes through the codec's URI transformer.
 */
export function remotePathFromUri(uri: URI): string {
  if (uri.scheme !== REMOTE_SCHEME) {
    throw new Error(`remoteUri.remotePathFromUri: expected ${REMOTE_SCHEME}, got ${uri.scheme}`)
  }
  return uri.fsPath
}

/**
 * The Windows UNC path (`\\wsl$\<distro>\...`) that opens a WSL remote's POSIX
 * path in the local Windows file manager (VS Code `toLocalFileUri` parity). The
 * distro name is canonicalized to lowercase (`wsl.exe -d` is case-insensitive);
 * a malformed WSL authority (e.g. one carrying a port) yields undefined.
 * Returns undefined for non-WSL authorities or non-absolute paths, leaving the
 * caller to fall back to its local-only behavior.
 */
export function wslUncPath(authority: string, posixPath: string): string | undefined {
  if (!isWslAuthority(authority) || !posixPath.startsWith('/')) return undefined
  const distro = normalizeRemoteAuthority(authority).slice(WSL_AUTHORITY_PREFIX.length)
  if (!isValidWslDistroName(distro)) return undefined
  return `\\\\wsl$\\${distro}${posixPath.replace(/\//g, '\\')}`
}

/**
 * The local (client-host) filesystem path a resource can be revealed at in the
 * OS file manager: `file` URIs reveal their own path; a WSL remote reveals the
 * `\\wsl$\` UNC path when the client is Windows. Undefined means "not
 * revealable" and the caller keeps its in-app fallback.
 */
export function localRevealFsPath(uri: URI, opts: { isWindows: boolean }): string | undefined {
  if (uri.scheme === 'file') return uri.fsPath
  if (uri.scheme === REMOTE_SCHEME && opts.isWindows) {
    return wslUncPath(uri.authority, uri.path)
  }
  return undefined
}
