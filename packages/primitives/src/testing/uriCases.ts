/**
 * The shared URI behaviour table: one input list, one set of expectations, run
 * against the kernel's `URI` and the extension SDK's `Uri` by both packages'
 * suites (plus an end-to-end parity check in `extension-host`).
 *
 * Two kinds of rows live here:
 *   - rows asserting the behaviour the two share (the reason this package exists
 *     — these were duplicated verbatim in two test files before);
 *   - rows pinning the places where they deliberately diverge (fsPath policy),
 *     so a future "let's unify the two implementations" change has to face them.
 *
 * This module is data only — it may not import anything but types, since it is
 * published alongside the package for the repo's own tests to consume.
 */
import type { UriComponents } from '../uri.js'

/** A URI string and the components both implementations must parse it into. */
export interface ParseCase {
  name: string
  /** Input to `parse`. */
  parse: string
  scheme: string
  authority: string
  path: string
  query: string
  fragment: string
  /** `toString()` of the parsed result; omitted when the round-trip is lossy. */
  stringForm?: string
  /** `toString(true)` of the parsed result (SDK only — the kernel has no skipEncoding). */
  skipEncodingForm?: string
}

export const PARSE_CASES: readonly ParseCase[] = [
  {
    name: 'scheme + authority + path + query + fragment',
    parse: 'https://example.com/foo/bar?x=1&y=2#section',
    scheme: 'https',
    authority: 'example.com',
    path: '/foo/bar',
    query: 'x=1&y=2',
    fragment: 'section',
    stringForm: 'https://example.com/foo/bar?x=1&y=2#section',
  },
  {
    name: 'file URI with a drive letter',
    parse: 'file:///D:/foo/bar.lua',
    scheme: 'file',
    authority: '',
    path: '/D:/foo/bar.lua',
    query: '',
    fragment: '',
    stringForm: 'file:///D:/foo/bar.lua',
  },
  {
    name: 'scheme-only',
    parse: 'mailto:',
    scheme: 'mailto',
    authority: '',
    path: '',
    query: '',
    fragment: '',
    stringForm: 'mailto:',
  },
  {
    name: 'empty string',
    parse: '',
    scheme: '',
    authority: '',
    path: '',
    query: '',
    fragment: '',
    stringForm: '',
  },
  {
    name: 'percent-encoded path',
    parse: 'file:///foo%20bar/baz',
    scheme: 'file',
    authority: '',
    path: '/foo bar/baz',
    query: '',
    fragment: '',
    stringForm: 'file:///foo%20bar/baz',
  },
  {
    name: 'delimiter characters inside the path',
    parse: 'file:///a%23b%3Fc',
    scheme: 'file',
    authority: '',
    path: '/a#b?c',
    query: '',
    fragment: '',
    stringForm: 'file:///a%23b%3Fc',
  },
  {
    name: 'percent-encoded authority in monaco form',
    parse: 'remote-ssh://wsl%2Bubuntu2004/home/x/a.ts',
    scheme: 'remote-ssh',
    authority: 'wsl+ubuntu2004',
    path: '/home/x/a.ts',
    query: '',
    fragment: '',
    stringForm: 'remote-ssh://wsl+ubuntu2004/home/x/a.ts',
  },
  {
    name: 'bare `+` in the authority',
    parse: 'remote-ssh://wsl+ubuntu2004/home/x',
    scheme: 'remote-ssh',
    authority: 'wsl+ubuntu2004',
    path: '/home/x',
    query: '',
    fragment: '',
    stringForm: 'remote-ssh://wsl+ubuntu2004/home/x',
  },
  {
    name: 'malformed percent-encoded authority is kept, not thrown on',
    parse: 'remote-ssh://wsl%2/home/x',
    scheme: 'remote-ssh',
    authority: 'wsl%2',
    path: '/home/x',
    query: '',
    fragment: '',
    // No toString row: re-encoding escapes the stray `%`, so the round-trip is lossy.
  },
  {
    name: 'UNC authority and path',
    parse: 'file://server/share/x',
    scheme: 'file',
    authority: 'server',
    path: '/share/x',
    query: '',
    fragment: '',
    stringForm: 'file://server/share/x',
  },
  {
    name: 'non-file scheme with a path',
    parse: 'untitled:/a/b',
    scheme: 'untitled',
    authority: '',
    path: '/a/b',
    query: '',
    fragment: '',
    stringForm: 'untitled:/a/b',
  },
  {
    name: 'skipEncoding leaves spaces alone but still encodes `#` / `?`',
    parse: 'file:///a%20b',
    scheme: 'file',
    authority: '',
    path: '/a b',
    query: '',
    fragment: '',
    stringForm: 'file:///a%20b',
    skipEncodingForm: 'file:///a b',
  },
  {
    name: 'skipEncoding keeps an already-encoded delimiter encoded',
    parse: 'file:///a%23b',
    scheme: 'file',
    authority: '',
    path: '/a#b',
    query: '',
    fragment: '',
    stringForm: 'file:///a%23b',
    skipEncodingForm: 'file:///a%23b',
  },
]

/** Components and the string form both implementations must produce for them. */
export interface FormatCase {
  name: string
  components: UriComponents
  stringForm: string
  /** `toString(true)`, when it differs from `toString()`. */
  skipEncodingForm?: string
}

export const FORMAT_CASES: readonly FormatCase[] = [
  {
    name: 'space in the path',
    components: { scheme: 'file', path: '/foo bar/baz' },
    stringForm: 'file:///foo%20bar/baz',
  },
  {
    name: 'non-file scheme without authority gets no `//`',
    components: { scheme: 'universe', path: '/welcome' },
    stringForm: 'universe:/welcome',
  },
  {
    name: '`+` survives in the authority',
    components: { scheme: 'remote-ssh', authority: 'wsl+ubuntu2004', path: '/home/x' },
    stringForm: 'remote-ssh://wsl+ubuntu2004/home/x',
  },
  {
    name: 'all-safe path is left unchanged',
    components: { scheme: 'file', path: '/a/b-c_d.txt' },
    stringForm: 'file:///a/b-c_d.txt',
  },
  {
    name: 'surrogate pair encodes as one code point',
    components: { scheme: 'file', path: '/a/🎉.txt' },
    stringForm: 'file:///a/%F0%9F%8E%89.txt',
  },
  {
    name: 'CJK Extension B character',
    components: { scheme: 'file', path: '/\u{20000}.txt' },
    stringForm: 'file:///%F0%A0%80%80.txt',
  },
  {
    name: 'a space and an emoji in the same run',
    components: { scheme: 'file', path: '/a 🎉b.txt' },
    stringForm: 'file:///a%20%F0%9F%8E%89b.txt',
  },
  {
    name: 'astral characters in path, query and fragment',
    components: { scheme: 'file', path: '/a/🎉/b.txt', query: 'q=🎉', fragment: '🎉' },
    stringForm: 'file:///a/%F0%9F%8E%89/b.txt?q=%F0%9F%8E%89#%F0%9F%8E%89',
  },
  {
    name: 'skipEncoding passes an astral path and space through untouched',
    components: { scheme: 'file', path: '/a/🎉 b' },
    stringForm: 'file:///a/%F0%9F%8E%89%20b',
    skipEncodingForm: 'file:///a/🎉 b',
  },
  {
    name: 'skipEncoding still encodes the authority',
    components: { scheme: 'remote-ssh', authority: 'wsl+ubuntu2004', path: '/a b' },
    stringForm: 'remote-ssh://wsl+ubuntu2004/a%20b',
    skipEncodingForm: 'remote-ssh://wsl+ubuntu2004/a b',
  },
  {
    name: '`#` and `?` inside the path are encoded',
    components: { scheme: 'file', path: '/a#b?c' },
    stringForm: 'file:///a%23b%3Fc',
    skipEncodingForm: 'file:///a%23b%3Fc',
  },
]

/**
 * A lone surrogate has no UTF-8 form: the encoder hands the whole run to
 * `encodeURIComponent` at once, which throws. Pinned so nobody "fixes" it with a
 * try/catch that would swallow real encoding failures too.
 */
export const FORMAT_THROWS_URIERROR: readonly { name: string; components: UriComponents }[] = [
  {
    name: 'lone high surrogate in the path',
    components: { scheme: 'file', path: '/a/\uD83C.txt' },
  },
]

/** `file()` normalization: OS path in, canonical components + string form out. */
export interface FileCase {
  name: string
  input: string
  authority: string
  path: string
  stringForm: string
}

export const FILE_CASES: readonly FileCase[] = [
  {
    name: 'windows drive with forward slashes',
    input: 'D:/foo/bar.lua',
    authority: '',
    path: '/D:/foo/bar.lua',
    stringForm: 'file:///D:/foo/bar.lua',
  },
  {
    name: 'windows drive with backslashes',
    input: 'D:\\foo\\bar.lua',
    authority: '',
    path: '/D:/foo/bar.lua',
    stringForm: 'file:///D:/foo/bar.lua',
  },
  {
    name: 'drive letter case is preserved',
    input: 'c:/x/y',
    authority: '',
    path: '/c:/x/y',
    stringForm: 'file:///c:/x/y',
  },
  {
    name: 'posix absolute path',
    input: '/usr/local/bin',
    authority: '',
    path: '/usr/local/bin',
    stringForm: 'file:///usr/local/bin',
  },
  {
    name: 'UNC path splits the server into the authority',
    input: '//server/share/file.txt',
    authority: 'server',
    path: '/share/file.txt',
    stringForm: 'file://server/share/file.txt',
  },
  {
    name: 'UNC path written with backslashes',
    input: '\\\\server\\share\\dir\\f.txt',
    authority: 'server',
    path: '/share/dir/f.txt',
    stringForm: 'file://server/share/dir/f.txt',
  },
  {
    name: 'UNC host without a share',
    input: '//server',
    authority: 'server',
    path: '/',
    stringForm: 'file://server/',
  },
]

/** `joinPath` on a parsed base: the resulting path (and authority, when relevant). */
export interface JoinPathCase {
  name: string
  base: string
  segments: readonly string[]
  path: string
  authority?: string
}

export const JOIN_PATH_CASES: readonly JoinPathCase[] = [
  {
    name: 'joins segments',
    base: 'file:///D:/foo',
    segments: ['sub', 'file.txt'],
    path: '/D:/foo/sub/file.txt',
  },
  {
    name: 'collapses leading/trailing slashes of the segments',
    base: 'file:///D:/foo/',
    segments: ['/sub/', '/file.txt'],
    path: '/D:/foo/sub/file.txt',
  },
  {
    name: 'resolves `..`',
    base: 'file:///D:/foo/bar',
    segments: ['..', 'baz'],
    path: '/D:/foo/baz',
  },
  {
    name: 'resolves `.`',
    base: 'file:///a/b',
    segments: ['./c'],
    path: '/a/b/c',
  },
  {
    name: '`..` at the root is ignored',
    base: 'file:///a',
    segments: ['..', '..', 'x'],
    path: '/x',
  },
  {
    name: 'keeps the authority',
    base: 'file://server/share',
    segments: ['dir', 'f.txt'],
    path: '/share/dir/f.txt',
    authority: 'server',
  },
  {
    name: 'empty segments are skipped',
    base: 'file:///a/b',
    segments: ['', 'c'],
    path: '/a/b/c',
  },
]

/**
 * The one place the two implementations are *meant* to differ: how a URI becomes
 * a filesystem path. The kernel never re-writes separators and keeps the drive
 * letter as written; the SDK produces the native form (`vscode.Uri.fsPath`).
 */
export interface FsPathCase {
  name: string
  uri: UriComponents
  kernel: string
  sdkPosix: string
  sdkWin32: string
}

export const FS_PATH_CASES: readonly FsPathCase[] = [
  {
    name: 'windows drive path',
    uri: { scheme: 'file', authority: '', path: '/D:/foo/bar.lua' },
    kernel: 'D:/foo/bar.lua',
    sdkPosix: 'd:/foo/bar.lua',
    sdkWin32: 'd:\\foo\\bar.lua',
  },
  {
    name: 'drive root',
    uri: { scheme: 'file', authority: '', path: '/C:' },
    kernel: 'C:',
    sdkPosix: 'c:',
    sdkWin32: 'c:',
  },
  {
    name: 'posix absolute path',
    uri: { scheme: 'file', authority: '', path: '/usr/bin' },
    kernel: '/usr/bin',
    sdkPosix: '/usr/bin',
    sdkWin32: '\\usr\\bin',
  },
  {
    name: 'UNC path folds the authority back in',
    uri: { scheme: 'file', authority: 'server', path: '/share/file.txt' },
    kernel: '//server/share/file.txt',
    sdkPosix: '//server/share/file.txt',
    sdkWin32: '\\\\server\\share\\file.txt',
  },
  {
    name: 'non-file scheme passes the path through',
    uri: { scheme: 'untitled', authority: '', path: '/a/b' },
    kernel: '/a/b',
    sdkPosix: '/a/b',
    sdkWin32: '\\a\\b',
  },
  {
    name: 'authority without a path yields an empty path in both',
    uri: { scheme: 'file', authority: 'a', path: '' },
    kernel: '',
    sdkPosix: '',
    sdkWin32: '',
  },
  {
    name: 'a root path with only one character is not a drive',
    uri: { scheme: 'file', authority: '', path: '/a' },
    kernel: '/a',
    sdkPosix: '/a',
    sdkWin32: '\\a',
  },
]
