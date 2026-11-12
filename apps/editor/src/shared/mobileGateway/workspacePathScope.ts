import {
  arePathsEqual,
  normalizeFsPath,
  relativePathUnder,
  REMOTE_SCHEME,
  type HostPlatform,
  type URI,
} from '@universe-editor/platform'

/**
 * Whether `candidate` is the workspace root or lives under it. Remote
 * authorities carry POSIX paths on the server, so they must be compared with
 * POSIX semantics even when the phone's PC is Windows. Local `file:` URIs
 * (including UNC paths, which also carry an authority) use the host platform.
 */
export function isPathWithinWorkspace(
  root: URI,
  candidate: URI,
  hostPlatform: HostPlatform,
): boolean {
  if (root.scheme !== candidate.scheme) return false
  if ((root.authority ?? '') !== (candidate.authority ?? '')) return false
  // `relativePathUnder` tests the `${root}/` prefix, which can never match the
  // POSIX root (`/` + `/` = `//`). Same scheme/authority is already checked.
  if (normalizeFsPath(root.fsPath) === '/') return true
  const platform: HostPlatform = root.scheme === REMOTE_SCHEME ? 'linux' : hostPlatform
  return (
    arePathsEqual(root.fsPath, candidate.fsPath, platform) ||
    relativePathUnder(root.fsPath, candidate.fsPath, platform) !== null
  )
}
