/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import { URI } from '@universe-editor/platform'
import { FileIconThemeData, loadIconThemeDocument } from '../fileIconThemeData.js'

function makeReader(files: Record<string, string>): (uri: URI) => Promise<string> {
  return async (uri) => {
    const text = files[uri.fsPath]
    if (text === undefined) {
      throw new Error(`ENOENT: ${uri.fsPath}`)
    }
    return text
  }
}

const LOCATION = URI.file('/ext/icon-pack/icons/icon-theme.json')

const MINIMAL_DOC = JSON.stringify({
  iconDefinitions: { _file: { iconPath: './file.svg' } },
  file: '_file',
})

describe('FileIconThemeData', () => {
  it('fromExtensionTheme composes id as extensionId-themeId', () => {
    const theme = FileIconThemeData.fromExtensionTheme(
      { id: 'my-icons', label: 'My Icons', path: './icons/x.json' },
      LOCATION,
      { extensionId: 'pub.icon-pack', extensionIsBuiltin: false },
    )
    expect(theme.id).toBe('pub.icon-pack-my-icons')
    expect(theme.settingsId).toBe('my-icons')
    expect(theme.label).toBe('My Icons')
    expect(theme.isLoaded).toBe(false)
  })

  it('ensureLoaded parses the document and generates the stylesheet', async () => {
    const theme = FileIconThemeData.fromExtensionTheme(
      { id: 'my-icons', path: './icons/x.json' },
      LOCATION,
      { extensionId: 'ext', extensionIsBuiltin: true },
    )
    await theme.ensureLoaded(makeReader({ [LOCATION.fsPath]: MINIMAL_DOC }))
    expect(theme.isLoaded).toBe(true)
    expect(theme.hasFileIcons).toBe(true)
    expect(theme.styleSheetContent).toContain('.show-file-icons .file-icon::before')
    expect(theme.styleSheetContent).toContain("url('/ext/icon-pack/icons/file.svg')")
    expect(theme.loadedFiles.map((u) => u.fsPath)).toEqual([LOCATION.fsPath])
  })

  it('ensureLoaded is a no-op once loaded', async () => {
    const files = { [LOCATION.fsPath]: MINIMAL_DOC }
    const theme = FileIconThemeData.fromExtensionTheme({ id: 'x', path: './x.json' }, LOCATION, {
      extensionId: 'ext',
      extensionIsBuiltin: true,
    })
    await theme.ensureLoaded(makeReader(files))
    files[LOCATION.fsPath] = JSON.stringify({ iconDefinitions: {}, file: undefined })
    await theme.ensureLoaded(makeReader(files))
    expect(theme.hasFileIcons).toBe(true)
  })

  it('reload regenerates the stylesheet from disk', async () => {
    const files = { [LOCATION.fsPath]: MINIMAL_DOC }
    const theme = FileIconThemeData.fromExtensionTheme({ id: 'x', path: './x.json' }, LOCATION, {
      extensionId: 'ext',
      extensionIsBuiltin: true,
    })
    await theme.ensureLoaded(makeReader(files))
    files[LOCATION.fsPath] = JSON.stringify({
      iconDefinitions: { _folder: { iconPath: './folder.svg' } },
      folder: '_folder',
    })
    await theme.reload(makeReader(files))
    expect(theme.hasFolderIcons).toBe(true)
    expect(theme.styleSheetContent).toContain('.folder-icon::before')
    expect(theme.styleSheetContent).not.toContain('file.svg')
  })

  it('noIconTheme is the built-in Universe Material entry: loaded, empty and id-less', () => {
    const none = FileIconThemeData.noIconTheme
    expect(none.id).toBe('')
    expect(none.label).toBe('Universe Material')
    expect(none.settingsId).toBeNull()
    expect(none.isLoaded).toBe(true)
    expect(none.hasFileIcons).toBe(false)
  })

  it('storage snapshot round-trips the generated css', async () => {
    const theme = FileIconThemeData.fromExtensionTheme(
      { id: 'my-icons', label: 'My Icons', path: './x.json' },
      LOCATION,
      { extensionId: 'ext', extensionIsBuiltin: true },
    )
    await theme.ensureLoaded(makeReader({ [LOCATION.fsPath]: MINIMAL_DOC }))
    const restored = FileIconThemeData.fromStorageSnapshot(theme.toStorageSnapshot())
    expect(restored).toBeDefined()
    expect(restored?.isLoaded).toBe(true)
    expect(restored?.styleSheetContent).toBe(theme.styleSheetContent)
    expect(restored?.hasFileIcons).toBe(true)
  })
})

describe('loadIconThemeDocument', () => {
  it('tolerates JSONC (comments + trailing commas)', async () => {
    const doc = await loadIconThemeDocument(
      makeReader({
        [LOCATION.fsPath]: `{
          // a comment
          "file": "_file",
        }`,
      }),
      LOCATION,
    )
    expect(doc.file).toBe('_file')
  })

  it('rejects non-object documents', async () => {
    await expect(
      loadIconThemeDocument(makeReader({ [LOCATION.fsPath]: '[1,2]' }), LOCATION),
    ).rejects.toThrow('Object expected')
  })

  it('rejects malformed JSON', async () => {
    await expect(
      loadIconThemeDocument(makeReader({ [LOCATION.fsPath]: '{ unquoted' }), LOCATION),
    ).rejects.toThrow('Problems parsing')
  })
})
