import { describe, expect, it } from 'vitest'
import { parseFileToOpen } from '../cliArgs.js'

describe('parseFileToOpen', () => {
  // Regression: `--user-data-dir <path>` (space form) must not have its value
  // mistaken for a folder to open. This was the cause of the user-data-dir
  // directory being reopened as a workspace on every launch.
  it('does not treat the value of --user-data-dir (space form) as a folder', () => {
    const argv = ['node', 'main.js', '--user-data-dir', 'C:\\Users\\kuro\\AppData\\Roaming\\App']
    expect(parseFileToOpen(argv, false)).toBeUndefined()
  })

  it('does not treat other valued flags (space form) as a folder', () => {
    expect(parseFileToOpen(['node', 'main.js', '--config-dir', '/some/dir'], false)).toBeUndefined()
    expect(parseFileToOpen(['node', 'main.js', '--update-url', '/some/url'], false)).toBeUndefined()
  })

  it('ignores the =value form (self-contained flag)', () => {
    expect(parseFileToOpen(['node', 'main.js', '--user-data-dir=/cli'], false)).toBeUndefined()
  })

  it('returns a real positional path after a valued flag', () => {
    const argv = ['node', 'main.js', '--user-data-dir', '/data', '/project']
    expect(parseFileToOpen(argv, false)).toBe('/project')
  })

  it('returns a positional path when no flags are present', () => {
    expect(parseFileToOpen(['node', 'main.js', '/project'], false)).toBe('/project')
  })

  it('handles a valued flag at the end with no following value', () => {
    expect(parseFileToOpen(['node', 'main.js', '--user-data-dir'], false)).toBeUndefined()
  })

  it('treats a valued flag followed by another flag as consuming nothing', () => {
    // `--user-data-dir --help /project`: the flag has no value, /project is the file.
    const argv = ['node', 'main.js', '--user-data-dir', '--help', '/project']
    expect(parseFileToOpen(argv, false)).toBe('/project')
  })

  it('skips boolean flags without consuming the next token', () => {
    expect(parseFileToOpen(['node', 'main.js', '--help', '/project'], false)).toBe('/project')
  })

  it('ignores deep-link arguments', () => {
    const argv = ['node', 'main.js', 'universe-editor://file/foo']
    expect(parseFileToOpen(argv, false)).toBeUndefined()
  })

  it('slices argv[1+] when packaged', () => {
    // Packaged: argv[0] is the exe; a bare positional at argv[1] is the file.
    expect(parseFileToOpen(['app.exe', '/project'], true)).toBe('/project')
  })
})
