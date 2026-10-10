import { describe, expect, it } from 'vitest'
import { EnablementState, type IExtensionEntry } from '../ExtensionsWorkbenchService.js'
import { filterExtensionEntries, parseExtensionListQuery } from '../extensionListQuery.js'

function entry(
  id: string,
  displayName: string,
  isBuiltin: boolean,
  description = '',
): IExtensionEntry {
  return {
    id,
    displayName,
    publisher: 'universe',
    description,
    version: '1.0.0',
    installed: true,
    outdated: false,
    installing: false,
    isBuiltin,
    isUnderDevelopment: false,
    enabled: true,
    enablementState: EnablementState.EnabledGlobally,
    isVersionIncompatible: false,
    installIncompatible: false,
  }
}

const ENTRIES = [
  entry(
    '@universe-editor/theme-monokai',
    'Monokai Theme',
    true,
    'Monokai theme for Visual Studio Code',
  ),
  entry('@universe-editor/git', 'Git', true, 'Git integration'),
  entry('vendor.eslint', 'ESLint', false, 'Lint your code'),
]

describe('parseExtensionListQuery', () => {
  it('treats plain text as a non-builtin query', () => {
    expect(parseExtensionListQuery('eslint')).toEqual({
      builtin: false,
      outdated: false,
      text: 'eslint',
    })
  })

  it('detects @builtin case-insensitively and strips it from the text', () => {
    expect(parseExtensionListQuery('@BUILTIN monokai')).toEqual({
      builtin: true,
      outdated: false,
      text: 'monokai',
    })
  })

  it('accepts a bare @builtin with empty text', () => {
    expect(parseExtensionListQuery(' @builtin ')).toEqual({
      builtin: true,
      outdated: false,
      text: '',
    })
  })

  it('reads @updates (and its @outdated alias) as a non-builtin query', () => {
    expect(parseExtensionListQuery('@updates')).toEqual({
      builtin: false,
      outdated: true,
      text: '',
    })
    expect(parseExtensionListQuery('@OUTDATED acme')).toEqual({
      builtin: false,
      outdated: true,
      text: 'acme',
    })
  })

  it('does not treat a word merely starting with updates as the filter', () => {
    expect(parseExtensionListQuery('@updatesonly')).toEqual({
      builtin: false,
      outdated: false,
      text: '@updatesonly',
    })
  })
})

describe('filterExtensionEntries', () => {
  it('excludes built-in extensions by default', () => {
    const result = filterExtensionEntries(ENTRIES, parseExtensionListQuery(''))
    expect(result.map((e) => e.id)).toEqual(['vendor.eslint'])
  })

  it('lists only built-in extensions for a bare @builtin query', () => {
    const result = filterExtensionEntries(ENTRIES, parseExtensionListQuery('@builtin'))
    expect(result.map((e) => e.id)).toEqual([
      '@universe-editor/theme-monokai',
      '@universe-editor/git',
    ])
  })

  it('filters built-in entries by text', () => {
    const result = filterExtensionEntries(ENTRIES, parseExtensionListQuery('@builtin monokai'))
    expect(result.map((e) => e.id)).toEqual(['@universe-editor/theme-monokai'])
  })

  it('matches plain text against description of installed extensions', () => {
    const result = filterExtensionEntries(ENTRIES, parseExtensionListQuery('lint your'))
    expect(result.map((e) => e.id)).toEqual(['vendor.eslint'])
  })

  it('keeps only installed entries that are behind for @updates', () => {
    const entries = [
      { ...entry('acme.old', 'Old', false), outdated: true },
      entry('acme.new', 'New', false),
      { ...entry('@universe-editor/git', 'Git', true), outdated: true },
      { ...entry('acme.gone', 'Gone', false), installed: false, outdated: true },
    ]
    const result = filterExtensionEntries(entries, parseExtensionListQuery('@updates'))
    expect(result.map((e) => e.id)).toEqual(['acme.old'])
  })
})
