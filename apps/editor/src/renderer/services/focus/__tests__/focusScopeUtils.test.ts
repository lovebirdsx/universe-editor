/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/renderer/services/focus/focusScopeUtils.ts
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import { UriIdentityService } from '@universe-editor/platform'
import {
  classifyFocusEntries,
  classifyFocusPath,
  isFocusVisible,
  normalizeFocusFolders,
  type FocusEntryKind,
} from '../focusScopeUtils.js'

const win32 = new UriIdentityService('win32')
const linux = new UriIdentityService('linux')

describe('normalizeFocusFolders', () => {
  it('keeps only entries whose value is exactly true', () => {
    expect(
      normalizeFocusFolders({ Client: true, Server: false, Tools: 1, Docs: 'yes' }, win32),
    ).toEqual(['Client'])
  })

  it('canonicalizes separators and strips leading/trailing slashes', () => {
    expect(
      normalizeFocusFolders({ '/Client/': true, 'Tools\\Editor': true, './Server': true }, win32),
    ).toEqual(['Client', 'Tools/Editor', 'Server'])
  })

  it('preserves the configured order (it is what the UI displays)', () => {
    expect(normalizeFocusFolders({ Server: true, Client: true }, win32)).toEqual([
      'Server',
      'Client',
    ])
  })

  it('collapses nested entries to their shallowest ancestor', () => {
    // Both A and A/B focused must yield just A — two overlapping recursive
    // watcher subscriptions would report every event under A/B twice.
    expect(normalizeFocusFolders({ 'A/B': true, A: true }, win32)).toEqual(['A'])
    expect(normalizeFocusFolders({ 'A/B/C': true, 'A/B': true, D: true }, win32)).toEqual([
      'A/B',
      'D',
    ])
  })

  it('keeps siblings that merely share a name prefix', () => {
    expect(normalizeFocusFolders({ Client: true, ClientTools: true }, win32)).toEqual([
      'Client',
      'ClientTools',
    ])
  })

  it('collapses nesting case-insensitively on win32 but not on linux', () => {
    const raw = { Client: true, 'client/Sub': true }
    expect(normalizeFocusFolders(raw, win32)).toEqual(['Client'])
    expect(normalizeFocusFolders(raw, linux)).toEqual(['Client', 'client/Sub'])
  })

  it('dedupes entries that differ only by case on win32', () => {
    expect(normalizeFocusFolders({ Client: true, client: true }, win32)).toEqual(['Client'])
    expect(normalizeFocusFolders({ Client: true, client: true }, linux)).toEqual([
      'Client',
      'client',
    ])
  })

  it('drops entries that address the workspace root itself', () => {
    expect(normalizeFocusFolders({ '.': true, '/': true, '': true }, win32)).toEqual([])
  })

  it('drops entries that escape the workspace root', () => {
    // Clamping `../Other` to the root would turn a typo into "focus everything".
    expect(normalizeFocusFolders({ '../Other': true, Client: true }, win32)).toEqual(['Client'])
  })

  it('resolves interior .. segments', () => {
    expect(normalizeFocusFolders({ 'Tools/../Client': true }, win32)).toEqual(['Client'])
  })
})

describe('classifyFocusPath', () => {
  const folders = ['Client', 'Tools/Editor']
  const noFiles: string[] = []

  it('treats everything as in scope when nothing is focused', () => {
    expect(classifyFocusPath('anything/at/all', false, [], [], true, linux)).toBe('inScope')
    expect(classifyFocusPath('anything/at/all', true, [], ['a.txt'], true, linux)).toBe('out')
  })

  it('puts a focus folder and its descendants in scope', () => {
    expect(classifyFocusPath('Client', true, folders, noFiles, true, linux)).toBe('inScope')
    expect(classifyFocusPath('Client/Source/main.cpp', false, folders, noFiles, true, linux)).toBe(
      'inScope',
    )
    expect(classifyFocusPath('Tools/Editor/src/app.ts', false, folders, noFiles, true, linux)).toBe(
      'inScope',
    )
  })

  it('marks ancestors of a focus folder as skeleton', () => {
    expect(classifyFocusPath('Tools', true, folders, noFiles, true, linux)).toBe('skeleton')
  })

  it('puts unrelated directories out of scope', () => {
    expect(classifyFocusPath('Engine', true, folders, noFiles, true, linux)).toBe('out')
    expect(classifyFocusPath('Tools/Cooker', true, folders, noFiles, true, linux)).toBe('out')
  })

  it('does not mistake a name-prefix sibling for a descendant', () => {
    expect(classifyFocusPath('ClientTools', true, folders, noFiles, true, linux)).toBe('out')
    expect(classifyFocusPath('ClientTools/x.ts', false, folders, noFiles, true, linux)).toBe('out')
  })

  it('gates root-level files on showRootFiles', () => {
    expect(classifyFocusPath('README.md', false, folders, noFiles, true, linux)).toBe('inScope')
    expect(classifyFocusPath('README.md', false, folders, noFiles, false, linux)).toBe('out')
  })

  it('always hides files inside a skeleton directory', () => {
    // Tools/ exists only as a path to Tools/Editor; its own files are noise
    // regardless of showRootFiles, which is about the workspace root only.
    expect(classifyFocusPath('Tools/build.bat', false, folders, noFiles, true, linux)).toBe('out')
    expect(classifyFocusPath('Tools/build.bat', false, folders, noFiles, false, linux)).toBe('out')
  })

  it('keeps the workspace root itself in scope', () => {
    expect(classifyFocusPath('', true, folders, noFiles, true, linux)).toBe('inScope')
  })

  // Regression: the focus settings live in .universe-editor/settings.json, so
  // hiding that directory locked the user's own settings file behind the filter
  // they would edit it to change.
  it('never hides the editor configuration directories', () => {
    expect(classifyFocusPath('.universe-editor', true, folders, noFiles, true, linux)).toBe(
      'inScope',
    )
    expect(
      classifyFocusPath('.universe-editor/settings.json', false, folders, noFiles, true, linux),
    ).toBe('inScope')
    expect(classifyFocusPath('.vscode', true, folders, noFiles, true, linux)).toBe('inScope')
    expect(classifyFocusPath('.vscode/settings.json', false, folders, noFiles, true, linux)).toBe(
      'inScope',
    )
  })

  it('keeps configuration directories visible even with root files hidden', () => {
    // showRootFiles is about README / build scripts; it must not be able to
    // hide the settings file, which is the escape hatch out of focus mode.
    expect(
      classifyFocusPath('.universe-editor/settings.json', false, folders, noFiles, false, linux),
    ).toBe('inScope')
  })

  it('exempts configuration directories at the root only', () => {
    // Exempting the name at any depth would be a wildcard hole in the filter.
    expect(classifyFocusPath('Engine/.vscode', true, folders, noFiles, true, linux)).toBe('out')
    expect(
      classifyFocusPath('Engine/.vscode/settings.json', false, folders, noFiles, true, linux),
    ).toBe('out')
  })

  it('exempts configuration directories case-insensitively on win32', () => {
    expect(classifyFocusPath('.VSCode', true, folders, noFiles, true, win32)).toBe('inScope')
    expect(
      classifyFocusPath('.Universe-Editor/settings.json', false, folders, noFiles, true, win32),
    ).toBe('inScope')
  })

  it('does not exempt a root-level file that merely carries the name', () => {
    // The exemption is about the configuration directories; a root *file* is
    // governed by showRootFiles like every other root file.
    expect(classifyFocusPath('.vscode', false, folders, noFiles, false, linux)).toBe('out')
    expect(classifyFocusPath('.vscode', false, folders, noFiles, true, linux)).toBe('inScope')
  })

  it('matches case-insensitively on win32 so a typed folder still resolves', () => {
    // The folders are typed by a human and the path comes from disk, so their
    // case will not match on win32. A case-sensitive test would classify the
    // focus folder itself as out of scope and render an empty tree.
    expect(classifyFocusPath('Client', true, ['client'], noFiles, true, win32)).toBe('inScope')
    expect(
      classifyFocusPath('Client/Source/main.cpp', false, ['client'], noFiles, true, win32),
    ).toBe('inScope')
    expect(classifyFocusPath('TOOLS', true, ['tools/editor'], noFiles, true, win32)).toBe(
      'skeleton',
    )
    expect(classifyFocusPath('Engine', true, ['client'], noFiles, true, win32)).toBe('out')
    // Prefix siblings must still not match once case is folded.
    expect(classifyFocusPath('ClientTools', true, ['client'], noFiles, true, win32)).toBe('out')
  })

  it('stays case-sensitive on linux, where two casings are two directories', () => {
    expect(classifyFocusPath('Client', true, ['client'], noFiles, true, linux)).toBe('out')
  })

  describe('focus files', () => {
    const files = ['Source/Client/Run.bat']

    it('puts the focus file itself in scope by exact identity', () => {
      expect(classifyFocusPath('Source/Client/Run.bat', false, [], files, false, linux)).toBe(
        'inScope',
      )
    })

    it('matches the focus file case-insensitively on win32', () => {
      expect(classifyFocusPath('source/client/run.BAT', false, [], files, false, win32)).toBe(
        'inScope',
      )
      expect(classifyFocusPath('source/client/run.BAT', false, [], files, false, linux)).toBe('out')
    })

    it('does not give scope to siblings or children of the focus file', () => {
      // A file entry names exactly one file; nothing under or beside it is
      // covered.
      expect(classifyFocusPath('Source/Client/Other.bat', false, [], files, false, linux)).toBe(
        'out',
      )
      expect(
        classifyFocusPath('Source/Client/Run.bat/nested.txt', false, [], files, false, linux),
      ).toBe('out')
    })

    it('marks ancestors of a focus file as skeleton so it stays reachable', () => {
      expect(classifyFocusPath('Source', true, [], files, false, linux)).toBe('skeleton')
      expect(classifyFocusPath('Source/Client', true, [], files, false, linux)).toBe('skeleton')
    })

    it('does not make a directory carrying the file path in scope', () => {
      // The disk said the entry is a file; a directory at the same path is a
      // different node and must not inherit the entry's scope. It is not a
      // skeleton either — skeleton means "strict ancestor of an entry".
      expect(classifyFocusPath('Source/Client/Run.bat', true, [], files, false, linux)).toBe('out')
    })

    it('a root-level focus file is in scope even with showRootFiles off', () => {
      // The entry itself is the scope; showRootFiles only governs *other*
      // root files.
      expect(classifyFocusPath('Run.bat', false, [], ['Run.bat'], false, linux)).toBe('inScope')
      expect(classifyFocusPath('README.md', false, [], ['Run.bat'], false, linux)).toBe('out')
    })

    it('files and folders compose', () => {
      expect(
        classifyFocusPath('Source/Client/Run.bat', false, ['Engine'], files, false, linux),
      ).toBe('inScope')
      expect(classifyFocusPath('Engine/x.cpp', false, ['Engine'], files, false, linux)).toBe(
        'inScope',
      )
      expect(classifyFocusPath('Source', true, ['Engine'], files, false, linux)).toBe('skeleton')
    })
  })
})

describe('classifyFocusEntries', () => {
  const statFrom =
    (map: Readonly<Record<string, FocusEntryKind>>) =>
    async (rel: string): Promise<FocusEntryKind> => {
      const kind = map[rel]
      if (kind === undefined) throw new Error(`ENOENT: ${rel}`)
      return kind
    }

  it('splits entries into folders / files / pendingFiles by disk kind', async () => {
    const buckets = await classifyFocusEntries(
      ['Client', 'Run.bat', 'Later.txt'],
      statFrom({ Client: 'directory', 'Run.bat': 'file' }),
      linux,
    )
    expect(buckets.folders).toEqual(['Client'])
    expect(buckets.files).toEqual(['Run.bat'])
    expect(buckets.pendingFiles).toEqual(['Later.txt'])
  })

  it('treats a rejected stat as missing, never fatal', async () => {
    const buckets = await classifyFocusEntries(['Gone'], statFrom({}), linux)
    expect(buckets.pendingFiles).toEqual(['Gone'])
  })

  it('folds a file entry nested under a focused directory', async () => {
    // The recursive directory subscription already covers it; keeping the file
    // would double-report every watcher event and ripgrep hit.
    const buckets = await classifyFocusEntries(
      ['Client', 'Client/Run.bat'],
      statFrom({ Client: 'directory', 'Client/Run.bat': 'file' }),
      linux,
    )
    expect(buckets.folders).toEqual(['Client'])
    expect(buckets.files).toEqual([])
  })

  it('folds a file entry case-insensitively on win32', async () => {
    const buckets = await classifyFocusEntries(
      ['Client', 'client/Run.bat'],
      statFrom({ Client: 'directory', 'client/Run.bat': 'file' }),
      win32,
    )
    expect(buckets.files).toEqual([])
  })

  it('keeps a file entry that only shares a name prefix with a directory', async () => {
    const buckets = await classifyFocusEntries(
      ['Client', 'ClientTools/Run.bat'],
      statFrom({ Client: 'directory', 'ClientTools/Run.bat': 'file' }),
      linux,
    )
    expect(buckets.files).toEqual(['ClientTools/Run.bat'])
  })

  it('keeps entry order within each bucket', async () => {
    const buckets = await classifyFocusEntries(
      ['b.bat', 'B', 'a.bat', 'A'],
      statFrom({ 'b.bat': 'file', B: 'directory', 'a.bat': 'file', A: 'directory' }),
      linux,
    )
    expect(buckets.folders).toEqual(['B', 'A'])
    expect(buckets.files).toEqual(['b.bat', 'a.bat'])
  })
})

describe('isFocusVisible', () => {
  const folders = ['Tools/Editor']

  it('counts skeleton directories as visible so the tree can render them', () => {
    expect(isFocusVisible('Tools', true, folders, [], true, linux)).toBe(true)
  })

  it('hides out-of-scope entries', () => {
    expect(isFocusVisible('Engine', true, folders, [], true, linux)).toBe(false)
  })

  it('shows the focus file and its ancestor skeletons', () => {
    const files = ['Source/Run.bat']
    expect(isFocusVisible('Source/Run.bat', false, [], files, false, linux)).toBe(true)
    expect(isFocusVisible('Source', true, [], files, false, linux)).toBe(true)
    expect(isFocusVisible('Source/Other.bat', false, [], files, false, linux)).toBe(false)
  })
})
