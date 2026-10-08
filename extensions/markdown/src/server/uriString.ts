/**
 * The one string form used to talk to the language service.
 *
 * `vscode-uri`'s `URI.toString()` folds a Windows drive letter to lower case and
 * encodes the `:` as `%3A` (`file:///E:/x` → `file:///e%3A/x`). The language
 * service computes relative links with a case-sensitive `path.posix.relative`,
 * while the rename events it is fed come from the kernel's `URI.toString()`
 * (drive kept upper case) — mixed spellings make a rewritten link degrade into
 * an absolute `../../../../E:/…`. The SDK's `Uri` shares the kernel's encoder
 * (`@universe-editor/primitives`), so going through it keeps one spelling; the
 * drive-letter fold additionally pulls already-lower-cased inputs (the `%3A`
 * form the renderer hands back) onto that same form.
 */
import { Uri, type UriComponents } from '@universe-editor/extension-api'

function foldDriveLetter(path: string): string {
  return path.replace(/^\/([a-z]):/, (_, drive: string) => `/${drive.toUpperCase()}:`)
}

export function uriString(uri: UriComponents): string {
  const path = uri.scheme === 'file' && uri.path ? foldDriveLetter(uri.path) : uri.path
  return Uri.from({
    scheme: uri.scheme ?? '',
    authority: uri.authority ?? '',
    path: path ?? '',
    query: uri.query ?? '',
    fragment: uri.fragment ?? '',
  }).toString()
}
