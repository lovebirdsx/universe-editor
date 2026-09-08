import { describe, expect, it } from 'vitest'
import { resolveExcludeDirs, resolveFocusScope, resolveFocusScopeDirs } from '../focusScope.js'

const ROOT = process.platform === 'win32' ? 'C:/ws' : '/ws'

function resolve(enabled: boolean, folders: Record<string, unknown>): string[] {
  return resolveFocusScopeDirs({ enabled, folders }, ROOT)
}

function exclude(values: string[]): string[] {
  return resolveExcludeDirs(values, ROOT)
}

/** A platform-shaped absolute path rooted under a scratch directory. */
function abs(p: string): string {
  return process.platform === 'win32' ? `C:/abs/${p}` : `/abs/${p}`
}

/**
 * Split-resolve `folders` against an in-memory disk shape. `dirs`/`files` list
 * the workspace-relative paths the stat should report as directories / files;
 * anything else stat reports as missing (undefined).
 */
function split(
  enabled: boolean,
  folders: Record<string, unknown>,
  shape: { dirs?: string[]; files?: string[] },
): Promise<{ dirs: string[]; files: string[] }> {
  const dirSet = new Set((shape.dirs ?? []).map((d) => `${ROOT}/${d}`))
  const fileSet = new Set((shape.files ?? []).map((f) => `${ROOT}/${f}`))
  return resolveFocusScope({ enabled, folders }, ROOT, async (p) => {
    if (dirSet.has(p)) return { isDirectory: true }
    if (fileSet.has(p)) return { isDirectory: false }
    return undefined
  })
}

describe('resolveFocusScopeDirs', () => {
  it('returns [] when focus is disabled, whatever the folders', () => {
    expect(resolve(false, { Client: true })).toEqual([])
  })

  it('returns [] when no key is exactly true', () => {
    expect(resolve(true, {})).toEqual([])
    expect(resolve(true, { Client: false })).toEqual([])
    expect(resolve(true, { Client: 'true' })).toEqual([])
    expect(resolve(true, { Client: 1 })).toEqual([])
  })

  it('joins true-valued keys onto the workspace root as absolute dirs', () => {
    expect(resolve(true, { Client: true, Server: true })).toEqual([
      `${ROOT}/Client`,
      `${ROOT}/Server`,
    ])
  })

  it('normalizes backslashes and strips leading/trailing separators', () => {
    expect(resolve(true, { 'Client\\Tools\\': true, '/Client/UI': true })).toEqual([
      `${ROOT}/Client/Tools`,
      `${ROOT}/Client/UI`,
    ])
  })

  it('resolves internal .. segments', () => {
    expect(resolve(true, { 'Client/../Server': true })).toEqual([`${ROOT}/Server`])
  })

  it('drops entries addressing the root itself or escaping it (no clamping)', () => {
    expect(
      resolve(true, { '.': true, '/': true, '': true, '../outside': true, 'a/../../b': true }),
    ).toEqual([])
  })

  it('collapses nested entries to the shallowest ancestor, either order', () => {
    expect(resolve(true, { Client: true, 'Client/Tools': true })).toEqual([`${ROOT}/Client`])
    expect(resolve(true, { 'Client/Tools': true, Client: true })).toEqual([`${ROOT}/Client`])
  })

  it('keeps sibling directories that only share a prefix', () => {
    expect(resolve(true, { Client: true, ClientTools: true })).toEqual([
      `${ROOT}/Client`,
      `${ROOT}/ClientTools`,
    ])
  })

  it('keeps one entry when two differ only by case on a case-insensitive host', () => {
    // Guard: dedupe and the nesting collapse must key identically. Keyed
    // differently, both survive dedupe, then each looks nested under the other
    // and BOTH get dropped — the scan silently widens back to the whole folder.
    const dirs = resolve(true, { Client: true, client: true })
    if (process.platform === 'win32' || process.platform === 'darwin') {
      expect(dirs).toEqual([`${ROOT}/Client`])
    } else {
      expect(dirs).toEqual([`${ROOT}/Client`, `${ROOT}/client`])
    }
  })

  it('collapses nesting case-insensitively on a case-insensitive host', () => {
    const dirs = resolve(true, { Client: true, 'client/Tools': true })
    if (process.platform === 'win32' || process.platform === 'darwin') {
      expect(dirs).toEqual([`${ROOT}/Client`])
    } else {
      expect(dirs).toEqual([`${ROOT}/Client`, `${ROOT}/client/Tools`])
    }
  })
})

describe('resolveFocusScope', () => {
  it('returns empty buckets when focus is disabled', async () => {
    expect(await split(false, { Client: true }, { dirs: ['Client'] })).toEqual({
      dirs: [],
      files: [],
    })
  })

  it('routes a directory entry to dirs and a file entry to files', async () => {
    const { dirs, files } = await split(
      true,
      { Client: true, 'Source/Client/Run.bat': true },
      { dirs: ['Client'], files: ['Source/Client/Run.bat'] },
    )
    expect(dirs).toEqual([`${ROOT}/Client`])
    expect(files).toEqual([`${ROOT}/Source/Client/Run.bat`])
  })

  it('keeps a MISSING entry in files, never guessing it was a directory', async () => {
    // A vanished path fed to the directory phase would build `<file>/...` — the
    // no-such-file p4 answers as clean and that empty answer would be
    // checkpointed forever. Keeping it in files routes it to the per-file query
    // that tolerates a vanished path.
    const { dirs, files } = await split(true, { 'Gone/Thing.txt': true }, {})
    expect(dirs).toEqual([])
    expect(files).toEqual([`${ROOT}/Gone/Thing.txt`])
  })

  it('drops a file entry nested under a resolved directory', async () => {
    // The recursive scan of `Client` already covers `Client/Run.bat`; reporting
    // both would double-scan the file.
    const { dirs, files } = await split(
      true,
      { Client: true, 'Client/Run.bat': true },
      { dirs: ['Client'], files: ['Client/Run.bat'] },
    )
    expect(dirs).toEqual([`${ROOT}/Client`])
    expect(files).toEqual([])
  })

  it('collapses nested directory entries but never files into them', async () => {
    const { dirs, files } = await split(
      true,
      { Client: true, 'Client/Tools': true, 'Client/Tools/x.bat': true },
      { dirs: ['Client', 'Client/Tools'], files: ['Client/Tools/x.bat'] },
    )
    expect(dirs).toEqual([`${ROOT}/Client`])
    expect(files).toEqual([])
  })

  it('drops entries addressing the root or escaping it from both buckets', async () => {
    const { dirs, files } = await split(true, { '.': true, '../outside': true }, {})
    expect(dirs).toEqual([])
    expect(files).toEqual([])
  })

  it('ignores keys whose value is not exactly true in both buckets', async () => {
    const { dirs, files } = await split(
      true,
      { Client: false, 'Run.bat': 'true', Other: 1 },
      { dirs: ['Client'], files: ['Run.bat', 'Other'] },
    )
    expect(dirs).toEqual([])
    expect(files).toEqual([])
  })
})

describe('resolveExcludeDirs', () => {
  it('returns [] for empty input', () => {
    expect(exclude([])).toEqual([])
  })

  it('joins relative entries onto the workspace root', () => {
    expect(exclude(['Client', 'Server/Tools'])).toEqual([`${ROOT}/Client`, `${ROOT}/Server/Tools`])
  })

  it('normalizes backslashes and resolves internal .. in relative entries', () => {
    expect(exclude(['Client\\Tools\\', 'Client/../Server'])).toEqual([
      `${ROOT}/Client/Tools`,
      `${ROOT}/Server`,
    ])
  })

  it('drops empty, root and escaping relative entries', () => {
    expect(exclude(['', '.', '../outside', 'a/../../b'])).toEqual([])
  })

  it('keeps absolute entries, canonicalized', () => {
    expect(exclude([`${abs('Other')}\\`, abs('Else')])).toEqual([abs('Other'), abs('Else')])
  })

  it('drops degenerate or escaping absolute entries', () => {
    if (process.platform === 'win32') {
      expect(exclude(['C:/', 'C:/../outside', 'C:/a/../../b'])).toEqual([])
    } else {
      expect(exclude(['/', '/../outside', '/a/../../b'])).toEqual([])
    }
  })

  it('canonicalizes UNC absolute entries', () => {
    expect(exclude(['//server/share/Sub/../Tools'])).toEqual(['//server/share/Tools'])
    expect(exclude(['//server/share', '//server/share/Sub'])).toEqual(['//server/share'])
  })

  it('collapses nested entries to the shallowest ancestor, either order', () => {
    expect(exclude(['Client', 'Client/Tools'])).toEqual([`${ROOT}/Client`])
    expect(exclude(['Client/Tools', 'Client'])).toEqual([`${ROOT}/Client`])
  })

  it('collapses a relative entry nested under an absolute ancestor', () => {
    expect(exclude([ROOT, 'Client'])).toEqual([ROOT])
    expect(exclude(['Client', ROOT])).toEqual([ROOT])
  })

  it('dedupes a relative entry against an absolute entry naming the same dir', () => {
    const absClient = process.platform === 'win32' ? 'C:/ws/Client' : '/ws/Client'
    expect(exclude(['Client', absClient])).toEqual([absClient])
  })

  it('treats leading single slash on Windows as relative to workspace root', () => {
    if (process.platform === 'win32') {
      expect(exclude(['/Client'])).toEqual([`${ROOT}/Client`])
    }
  })

  it('keeps sibling directories that only share a prefix', () => {
    expect(exclude(['Client', 'ClientTools'])).toEqual([`${ROOT}/Client`, `${ROOT}/ClientTools`])
  })

  it('keeps one entry when two differ only by case on a case-insensitive host', () => {
    const dirs = exclude(['Client', 'client'])
    if (process.platform === 'win32' || process.platform === 'darwin') {
      expect(dirs).toEqual([`${ROOT}/Client`])
    } else {
      expect(dirs).toEqual([`${ROOT}/Client`, `${ROOT}/client`])
    }
  })

  it('collapses nesting case-insensitively on a case-insensitive host', () => {
    const dirs = exclude(['Client', 'client/Tools'])
    if (process.platform === 'win32' || process.platform === 'darwin') {
      expect(dirs).toEqual([`${ROOT}/Client`])
    } else {
      expect(dirs).toEqual([`${ROOT}/Client`, `${ROOT}/client/Tools`])
    }
  })
})
