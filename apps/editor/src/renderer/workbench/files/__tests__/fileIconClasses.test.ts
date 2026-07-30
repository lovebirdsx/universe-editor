/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import { URI } from '@universe-editor/platform'
import { getFileIconClasses } from '../fileIconClasses.js'

describe('getFileIconClasses', () => {
  it('files carry base + name + suffix-chain classes', () => {
    // Dots in names are CSS-escaped ('foo.ts' → 'foo\2e ts') — the DOM class
    // list never tokenizes the escape, and the generated stylesheet emits the
    // identical escape, so selectors match.
    expect(getFileIconClasses(URI.file('/w/foo.ts'), { isDirectory: false })).toEqual([
      'file-icon',
      'foo\\2e ts-name-file-icon',
      'ts-ext-file-icon',
    ])
  })

  it('multi-dot names emit every full suffix chain', () => {
    expect(getFileIconClasses(URI.file('/w/foo.spec.ts'), { isDirectory: false })).toEqual([
      'file-icon',
      'foo\\2e spec\\2e ts-name-file-icon',
      // The dot inside each chain is CSS-escaped ('spec.ts' → 'spec\2e ts').
      'spec\\2e ts-ext-file-icon',
      'ts-ext-file-icon',
    ])
  })

  it('lowercases names', () => {
    expect(getFileIconClasses(URI.file('/w/README.md'), { isDirectory: false })).toEqual([
      'file-icon',
      'readme\\2e md-name-file-icon',
      'md-ext-file-icon',
    ])
  })

  it('language id adds the lang fallback class', () => {
    const classes = getFileIconClasses(URI.file('/w/foo.unknownext'), {
      isDirectory: false,
      languageId: 'jsonc',
    })
    expect(classes).toContain('jsonc-lang-file-icon')
  })

  it('directories carry folder-icon + name-folder-icon', () => {
    expect(getFileIconClasses(URI.file('/w/src'), { isDirectory: true })).toEqual([
      'folder-icon',
      'src-name-folder-icon',
    ])
  })

  it('root directories carry rootfolder-icon + root-name-folder-icon', () => {
    expect(getFileIconClasses(URI.file('/w'), { isDirectory: true, isRoot: true })).toEqual([
      'rootfolder-icon',
      'w-root-name-folder-icon',
    ])
  })

  it('spaces in names are escaped to slashes (kept verbatim)', () => {
    const classes = getFileIconClasses(URI.file('/w/docker compose.yml'), { isDirectory: false })
    expect(classes[1]).toBe('docker/compose\\2e yml-name-file-icon')
  })
})
