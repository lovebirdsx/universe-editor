/*---------------------------------------------------------------------------------------------
 *  Cold-start language association race: models created before an extension's
 *  `contributes.languages` translated land as plaintext; the resync sweep
 *  upgrades them once the registration arrives.
 *--------------------------------------------------------------------------------------------*/
import { afterEach, describe, expect, it } from 'vitest'
import { URI } from '@universe-editor/platform'
import { languageRegistry } from '../../services/languages/LanguageRegistry.js'
import { resyncModelLanguages } from '../ModelLanguageResyncContribution.js'

interface FakeModel {
  uri: { toString(): string }
  languageId: string
  disposed: boolean
  isDisposed(): boolean
  getLanguageId(): string
}

function fakeModel(uri: string, languageId: string): FakeModel {
  return {
    uri: { toString: () => uri },
    languageId,
    disposed: false,
    isDisposed() {
      return this.disposed
    },
    getLanguageId() {
      return this.languageId
    },
  }
}

function fakeMonaco(models: FakeModel[], knownLanguages: string[] = ['plaintext']) {
  const registered: string[] = []
  const known = [...knownLanguages]
  return {
    registered,
    editor: {
      getModels: () => models,
      setModelLanguage: (model: FakeModel, languageId: string) => {
        model.languageId = languageId
      },
    },
    languages: {
      getLanguages: () => known.map((id) => ({ id })),
      register: (language: { id: string }) => {
        registered.push(language.id)
        known.push(language.id)
      },
    },
  }
}

function contributeLanguage(id: string, extensions: string[]): void {
  languageRegistry.registerLanguages([
    {
      id,
      extensions,
      extensionLocation: URI.file('/ext/root'),
      sourceExtensionId: 'test.ext',
    },
  ])
}

afterEach(() => languageRegistry._resetForTests())

describe('resyncModelLanguages', () => {
  it('upgrades plaintext models whose resource now resolves to a contributed language', () => {
    const model = fakeModel('file:///ws/data.rbcsv', 'plaintext')
    const monaco = fakeMonaco([model])
    contributeLanguage('rainbowcsv', ['.rbcsv'])
    resyncModelLanguages(monaco)
    expect(model.languageId).toBe('rainbowcsv')
  })

  it('self-registers an unknown language id with monaco before switching', () => {
    const model = fakeModel('file:///ws/data.rbcsv', 'plaintext')
    const monaco = fakeMonaco([model])
    contributeLanguage('rainbowcsv', ['.rbcsv'])
    resyncModelLanguages(monaco)
    expect(monaco.registered).toEqual(['rainbowcsv'])
  })

  it('leaves non-plaintext, disposed, and still-unresolved models alone', () => {
    const typed = fakeModel('file:///ws/data.rbcsv', 'markdown')
    const disposed = fakeModel('file:///ws/other.rbcsv', 'plaintext')
    disposed.disposed = true
    const unresolved = fakeModel('file:///ws/no-association.xyzzy', 'plaintext')
    const monaco = fakeMonaco([typed, disposed, unresolved])
    contributeLanguage('rainbowcsv', ['.rbcsv'])
    resyncModelLanguages(monaco)
    expect(typed.languageId).toBe('markdown')
    expect(disposed.languageId).toBe('plaintext')
    expect(unresolved.languageId).toBe('plaintext')
    expect(monaco.registered).toEqual([])
  })
})
