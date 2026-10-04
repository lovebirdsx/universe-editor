/**
 * Parameterized path-helper cases, shared by every layer that consumes
 * `@universe-editor/primitives`' path module:
 *  - `packages/primitives` — drives the leaf functions directly,
 *  - `packages/extension-api` — drives `workspaceFolderName` / `asRelativePathImpl`,
 *  - `packages/platform` — drives the kernel's public re-exports.
 *
 * Each row carries both the normalized slash form and the workspace folder name
 * for the same input, because the two come from *different* strip policies
 * (strip-all vs strip-one) and the pair is what makes the difference visible:
 * `basename('a//')` is `''`, while `basename(normalizeSlashes('a//'))` is `'a'`.
 */

export interface PathCase {
  /** What the row pins, e.g. 'double trailing slash collapses to the folder'. */
  name: string
  input: string
  /** `normalizeSlashes(input)` — forward slashes, all trailing slashes gone. */
  slashes: string
  /** `basename(normalizeSlashes(input))` — the workspace folder name. */
  folderName: string
}

export const PATH_CASES: readonly PathCase[] = [
  { name: 'empty stays empty', input: '', slashes: '', folderName: '' },
  { name: 'posix root', input: '/', slashes: '/', folderName: '' },
  { name: 'repeated posix root', input: '///', slashes: '/', folderName: '' },
  { name: 'plain name', input: 'ws', slashes: 'ws', folderName: 'ws' },
  { name: 'posix absolute', input: '/home/dev/ws', slashes: '/home/dev/ws', folderName: 'ws' },
  { name: 'one trailing slash', input: '/home/dev/ws/', slashes: '/home/dev/ws', folderName: 'ws' },
  {
    name: 'repeated trailing slashes are all stripped',
    input: '/home/dev/ws///',
    slashes: '/home/dev/ws',
    folderName: 'ws',
  },
  { name: 'trailing slash on a bare name', input: 'a//', slashes: 'a', folderName: 'a' },
  { name: 'windows separators', input: 'C:\\ws\\sub', slashes: 'C:/ws/sub', folderName: 'sub' },
  { name: 'windows drive root keeps its colon', input: 'C:\\', slashes: 'C:', folderName: 'C:' },
  {
    name: 'windows drive with trailing slash',
    input: 'D:/ws/',
    slashes: 'D:/ws',
    folderName: 'ws',
  },
  {
    name: 'unc-like prefix keeps the empty host segment',
    input: '//host/share/',
    slashes: '//host/share',
    folderName: 'share',
  },
  { name: 'interior duplicate slashes survive', input: 'a//b', slashes: 'a//b', folderName: 'b' },
  {
    name: 'dots are not resolved here',
    input: '/ws/./a/..',
    slashes: '/ws/./a/..',
    folderName: '..',
  },
]
