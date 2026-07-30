/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import { URI } from '@universe-editor/platform'
import {
  cssClassName,
  cssStringValue,
  processIconThemeDocument,
  type IIconThemeDocument,
} from '../generateFileIconThemeCss.js'

const THEME_LOCATION = URI.file('/ext/theme-defaults/icons/theme-icon-theme.json')

function processDoc(doc: IIconThemeDocument) {
  return processIconThemeDocument('test-theme', THEME_LOCATION, doc)
}

describe('processIconThemeDocument', () => {
  it('returns an empty stylesheet when iconDefinitions is missing', () => {
    const result = processDoc({ file: '_file' })
    expect(result.content).toBe('')
    expect(result.hasFileIcons).toBe(false)
    expect(result.hidesExplorerArrows).toBe(false)
  })

  it('generates background-image rules for iconPath definitions', () => {
    const result = processDoc({
      iconDefinitions: { _file: { iconPath: './file.svg' } },
      file: '_file',
    })
    expect(result.hasFileIcons).toBe(true)
    expect(result.content).toContain(
      ".show-file-icons .file-icon::before { content: '\\2001'; background-image: url('/ext/theme-defaults/icons/file.svg'); }",
    )
  })

  it('resolves iconPath against the theme file directory', () => {
    const result = processDoc({
      iconDefinitions: { _folder: { iconPath: './images/folder.svg' } },
      folder: '_folder',
    })
    expect(result.content).toContain("url('/ext/theme-defaults/icons/images/folder.svg')")
    expect(result.hasFolderIcons).toBe(true)
  })

  it('uses resolveResourceUrl for asset URLs when provided', () => {
    const result = processIconThemeDocument(
      'test-theme',
      THEME_LOCATION,
      { iconDefinitions: { _file: { iconPath: './file.svg' } }, file: '_file' },
      (uri) => `universe-app://root/_resource_${uri.fsPath}`,
    )
    expect(result.content).toContain(
      "url('universe-app://root/_resource_/ext/theme-defaults/icons/file.svg')",
    )
  })

  it('generates folder expanded selectors with the folder-expanded-icon class', () => {
    const result = processDoc({
      iconDefinitions: { _open: { iconPath: './open.svg' } },
      folderExpanded: '_open',
    })
    expect(result.content).toContain('.show-file-icons .folder-expanded-icon::before')
  })

  it('folderNames selectors carry the name-folder-icon class', () => {
    const result = processDoc({
      iconDefinitions: { _src: { iconPath: './src.svg' } },
      folderNames: { src: '_src' },
    })
    expect(result.content).toContain('.src-name-folder-icon.folder-icon::before')
  })

  it('folderNamesExpanded wins alongside folderNames with the expanded class', () => {
    const result = processDoc({
      iconDefinitions: {
        _closed: { iconPath: './closed.svg' },
        _open: { iconPath: './open.svg' },
      },
      folderNames: { src: '_closed' },
      folderNamesExpanded: { src: '_open' },
    })
    expect(result.content).toContain(
      '.show-file-icons .src-name-folder-icon.folder-icon::before { content:',
    )
    expect(result.content).toContain(
      ".show-file-icons .src-name-folder-icon.folder-expanded-icon::before { content: '\\2001'; background-image: url('/ext/theme-defaults/icons/open.svg'); }",
    )
  })

  it('fileExtensions selectors add the .ext-file-icon specificity booster', () => {
    const result = processDoc({
      iconDefinitions: { _ts: { iconPath: './ts.svg' } },
      fileExtensions: { ts: '_ts' },
    })
    expect(result.content).toContain('.ts-ext-file-icon.ext-file-icon.file-icon::before')
  })

  it('multi-segment extensions (spec.ts) emit a selector per suffix chain', () => {
    const result = processDoc({
      iconDefinitions: { _spec: { iconPath: './spec.svg' } },
      fileExtensions: { 'spec.ts': '_spec' },
    })
    // VSCode's getIconClasses pushes every full suffix chain ('spec.ts', 'ts');
    // the dot in 'spec.ts' is CSS-escaped.
    expect(result.content).toContain('.spec\\2e ts-ext-file-icon.ext-file-icon.file-icon::before')
    expect(result.content).toContain('.ts-ext-file-icon.ext-file-icon.file-icon::before')
  })

  it('fileNames selectors carry name + extension segment classes', () => {
    const result = processDoc({
      iconDefinitions: { _pkg: { iconPath: './pkg.svg' } },
      fileNames: { 'package.json': '_pkg' },
    })
    // `.package\2e json-...` is the CSS.escape form of the "package.json" class
    // (the space terminates the hex escape; DOM classList never tokenizes it).
    expect(result.content).toContain(
      '.package\\2e json-name-file-icon.name-file-icon.file-icon::before',
    )
    expect(result.content).toContain('.json-ext-file-icon.ext-file-icon.file-icon::before')
  })

  it('languageIds selectors carry lang-file-icon; json also applies to jsonc', () => {
    const result = processDoc({
      iconDefinitions: { _json: { iconPath: './json.svg' } },
      languageIds: { json: '_json' },
    })
    expect(result.content).toContain('.json-lang-file-icon.file-icon::before')
    expect(result.content).toContain('.jsonc-lang-file-icon.file-icon::before')
  })

  it('light associations are prefixed with the .vs qualifier', () => {
    const result = processDoc({
      iconDefinitions: { _light: { iconPath: './light.svg' } },
      light: { file: '_light' },
    })
    expect(result.content).toContain('.vs .show-file-icons .file-icon::before')
  })

  it('highContrast associations get both hc qualifiers', () => {
    const result = processDoc({
      iconDefinitions: { _hc: { iconPath: './hc.svg' } },
      highContrast: { file: '_hc' },
    })
    expect(result.content).toContain('.hc-black .show-file-icons .file-icon::before')
    expect(result.content).toContain('.hc-light .show-file-icons .file-icon::before')
  })

  it('generates @font-face and font character rules for glyph definitions', () => {
    const result = processDoc({
      iconDefinitions: { _git: { fontCharacter: '\\E001', fontColor: '#519aba' } },
      fonts: [{ id: 'seti', src: [{ path: './seti.woff', format: 'woff' }] }],
      file: '_git',
    })
    expect(result.content).toContain(
      "@font-face { src: url('/ext/theme-defaults/icons/seti.woff') format('woff'); font-family: 'seti'; font-display: block; }",
    )
    // The fontCharacter `\E001` is passed through into the content string with
    // its backslash escaped for the CSS string literal.
    expect(result.content).toContain(
      ".show-file-icons .file-icon::before { content: '\\\\E001'; color: #519aba; font-family: 'seti'; }",
    )
  })

  it('font baseline rule applies the first font to all icon pseudo elements', () => {
    const result = processDoc({
      iconDefinitions: { _x: { fontCharacter: '\\E002' } },
      fonts: [{ id: 'seti', size: '150%', src: [{ path: './s.woff', format: 'woff' }] }],
      file: '_x',
    })
    expect(result.content).toContain(
      ".show-file-icons .file-icon::before, .show-file-icons .folder-icon::before, .show-file-icons .rootfolder-icon::before { font-family: 'seti'; font-size: 150%; }",
    )
  })

  it('px font sizes normalize against the 13px baseline', () => {
    const result = processDoc({
      iconDefinitions: { _x: { fontCharacter: '\\E003', fontSize: '26px' } },
      fonts: [{ id: 'seti', src: [{ path: './s.woff', format: 'woff' }] }],
      file: '_x',
    })
    expect(result.content).toContain('font-size: 200%')
  })

  it('rootFolder falls back to folder; selectors use rootfolder-icon', () => {
    const result = processDoc({
      iconDefinitions: { _folder: { iconPath: './folder.svg' } },
      folder: '_folder',
    })
    expect(result.content).toContain('.show-file-icons .rootfolder-icon::before')
  })

  it('hidesExplorerArrows passes through', () => {
    expect(processDoc({ iconDefinitions: {}, hidesExplorerArrows: true }).hidesExplorerArrows).toBe(
      true,
    )
  })

  it('multiple selectors for one definition join with commas', () => {
    const result = processDoc({
      iconDefinitions: { _cfg: { iconPath: './cfg.svg' } },
      fileExtensions: { ini: '_cfg' },
      fileNames: { '.editorconfig': '_cfg' },
    })
    // One rule whose selector list contains both the extension and the name
    // selectors, comma-joined.
    expect(result.content).toMatch(
      /\.show-file-icons \.ini-ext-file-icon\.ext-file-icon\.file-icon::before, \.show-file-icons .*editorconfig/,
    )
  })

  it('names with spaces are escaped to slashes in selectors', () => {
    const result = processDoc({
      iconDefinitions: { _docker: { iconPath: './d.svg' } },
      fileNames: { 'docker compose': '_docker' },
    })
    expect(result.content).toContain('docker/compose')
  })
})

describe('cssStringValue', () => {
  it('wraps in single quotes and escapes embedded quotes', () => {
    expect(cssStringValue("it's")).toBe("'it\\000027s'")
  })
})

describe('cssClassName', () => {
  it('keeps identifier-safe names untouched', () => {
    expect(cssClassName('typescript')).toBe('typescript')
  })

  it('hex-escapes characters outside the identifier set', () => {
    expect(cssClassName('a.b')).toBe('a\\2e b')
  })
})
