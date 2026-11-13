import { describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import { win32 } from 'node:path'
import {
  hasAgentSessionsFlag,
  hasBackgroundFlag,
  hasQuitFlag,
  parseFileToOpen,
  parseQuitSkipSession,
} from '../cliArgs.js'

describe('parseFileToOpen', () => {
  // Regression: `--user-data-dir <path>` (space form) must not have its value
  // mistaken for a folder to open. This was the cause of the user-data-dir
  // directory being reopened as a workspace on every launch.
  it('does not treat the value of --user-data-dir (space form) as a folder', () => {
    const argv = [
      'node',
      'main.js',
      '--user-data-dir',
      'C:\\Users\\testuser\\AppData\\Roaming\\App',
    ]
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

  it('never treats --quit as a path and keeps a following path', () => {
    expect(parseFileToOpen(['node', 'main.js', '--quit'], false)).toBeUndefined()
    expect(parseFileToOpen(['node', 'main.js', '--quit', '/project'], false)).toBe('/project')
  })

  it('never treats --agent-sessions as a path and keeps a following path', () => {
    expect(parseFileToOpen(['node', 'main.js', '--agent-sessions'], false)).toBeUndefined()
    expect(parseFileToOpen(['node', 'main.js', '--agent-sessions', '/project'], false)).toBe(
      '/project',
    )
  })

  it('never treats --background as a path and keeps a following path', () => {
    expect(parseFileToOpen(['node', 'main.js', '--background'], false)).toBeUndefined()
    expect(parseFileToOpen(['node', 'main.js', '--background', '/project'], false)).toBe('/project')
  })

  it('slices argv[1+] when packaged', () => {
    // Packaged: argv[0] is the exe; a bare positional at argv[1] is the file.
    expect(parseFileToOpen(['app.exe', '/project'], true)).toBe('/project')
  })
})

describe('parseFileToOpen (Windows Explorer quoting)', () => {
  // Regression: Explorer's `"<exe>" "%V"` template turns a drive root `D:\`
  // into the command line `"<exe>" "D:\"`; the trailing backslash escapes the
  // closing quote, so argv receives `D:"` and fs.stat fails -> opened as a file.
  it('repairs the drive root mangled by the quoted context-menu command', () => {
    expect(parseFileToOpen(['app.exe', 'D:"'], true, 'win32')).toBe('D:\\')
  })

  it('repairs the mangled root in dev-mode argv', () => {
    expect(parseFileToOpen(['electron', 'main.js', 'D:"'], false, 'win32')).toBe('D:\\')
  })

  it('repairs a UNC share root', () => {
    expect(parseFileToOpen(['app.exe', '\\\\server\\share"'], true, 'win32')).toBe(
      '\\\\server\\share',
    )
  })

  it('leaves an already-correct drive root and ordinary paths untouched', () => {
    expect(parseFileToOpen(['app.exe', 'D:\\'], true, 'win32')).toBe('D:\\')
    const file = 'C:\\Users\\test user\\my project\\file.ts'
    expect(parseFileToOpen(['app.exe', file], true, 'win32')).toBe(file)
  })

  it('does not turn a user-typed bare drive into the root', () => {
    // `D:` is drive-relative; only the quote artifact means the selected root.
    expect(parseFileToOpen(['app.exe', 'D:'], true, 'win32')).toBe('D:')
  })

  it('does not strip quotes on non-Windows platforms', () => {
    expect(parseFileToOpen(['app.exe', 'D:"'], true, 'linux')).toBe('D:"')
    expect(parseFileToOpen(['app.exe', 'D:"'], true, 'darwin')).toBe('D:"')
  })

  it('does not repair the value consumed by a valued flag', () => {
    expect(
      parseFileToOpen(['app.exe', '--user-data-dir', 'D:"', 'C:\\project'], true, 'win32'),
    ).toBe('C:\\project')
    expect(parseFileToOpen(['app.exe', '--user-data-dir', 'D:"'], true, 'win32')).toBeUndefined()
  })

  it('still ignores deep links', () => {
    expect(
      parseFileToOpen(['app.exe', 'universe-editor://file/foo"'], true, 'win32'),
    ).toBeUndefined()
  })

  const windowsRoot = win32.parse(process.cwd()).root
  it.skipIf(process.platform !== 'win32' || !/^[A-Za-z]:\\$/.test(windowsRoot))(
    'defaults to the host platform and yields a stat-able directory',
    async () => {
      const mangled = `${windowsRoot.slice(0, -1)}"` // `D:\` -> `D:"`
      // Two-arg call deliberately exercises the process.platform default.
      const parsed = parseFileToOpen(['app.exe', mangled], true)
      expect(parsed).toBe(windowsRoot)
      expect((await fs.stat(parsed!)).isDirectory()).toBe(true)
    },
  )
})

describe('hasQuitFlag', () => {
  it('detects the flag anywhere in argv', () => {
    expect(hasQuitFlag(['app.exe', '--quit'])).toBe(true)
    expect(hasQuitFlag(['app.exe', '/project', '--quit'])).toBe(true)
    expect(hasQuitFlag(['app.exe', '--quit-other'])).toBe(false)
    expect(hasQuitFlag(['app.exe'])).toBe(false)
  })
})

describe('hasAgentSessionsFlag', () => {
  it('detects the exact flag anywhere in argv', () => {
    expect(hasAgentSessionsFlag(['app.exe', '--agent-sessions'])).toBe(true)
    expect(hasAgentSessionsFlag(['app.exe', '/project', '--agent-sessions'])).toBe(true)
    expect(hasAgentSessionsFlag(['app.exe', '--agent-sessions-other'])).toBe(false)
    expect(hasAgentSessionsFlag(['app.exe'])).toBe(false)
  })
})

describe('hasBackgroundFlag', () => {
  it('detects the exact flag anywhere in argv', () => {
    expect(hasBackgroundFlag(['app.exe', '--background'])).toBe(true)
    expect(hasBackgroundFlag(['app.exe', '/project', '--background'])).toBe(true)
    expect(hasBackgroundFlag(['app.exe', '--background-other'])).toBe(false)
    expect(hasBackgroundFlag(['app.exe'])).toBe(false)
  })
})

describe('parseQuitSkipSession', () => {
  it('reads the id from the =value form', () => {
    expect(parseQuitSkipSession(['app.exe', '--quit', '--quit-skip-session=sess-1'])).toBe('sess-1')
  })

  it('ignores the flag when the id is missing', () => {
    expect(parseQuitSkipSession(['app.exe', '--quit'])).toBeUndefined()
    expect(parseQuitSkipSession(['app.exe', '--quit-skip-session='])).toBeUndefined()
    expect(parseQuitSkipSession(['app.exe', '--quit-skip-session=   '])).toBeUndefined()
  })

  it('does not treat the =value token as a folder to open', () => {
    expect(
      parseFileToOpen(['app.exe', '--quit', '--quit-skip-session=sess-1'], true),
    ).toBeUndefined()
  })
})
