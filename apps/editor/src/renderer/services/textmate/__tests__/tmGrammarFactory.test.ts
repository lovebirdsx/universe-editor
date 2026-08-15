/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  Integration pin for the whole TextMate chain with the REAL moving parts:
 *  vscode-textmate + the real oniguruma wasm + the shipped TypeScript grammar.
 *  If a dependency upgrade or a grammar-file change breaks tokenization, this
 *  fails before any editor opens uncolored.
 *--------------------------------------------------------------------------------------------*/

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { INITIAL, type IGrammar, type IOnigLib } from 'vscode-textmate'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { GrammarRegistry, type IGrammarDefinition } from '../grammarRegistry.js'
import { TMGrammarFactory } from '../tmGrammarFactory.js'
import { URI } from '@universe-editor/platform'

const require = createRequire(import.meta.url)
const repoRoot = join(fileURLToPath(import.meta.url), '../../../../../../../..')
const TS_GRAMMAR_PATH = join(
  repoRoot,
  'extensions/textmate-grammars/syntaxes/TypeScript.tmLanguage.json',
)

let onigLib: IOnigLib

beforeAll(async () => {
  const oniguruma = require('vscode-oniguruma') as typeof import('vscode-oniguruma')
  const wasmPath = require.resolve('vscode-oniguruma/release/onig.wasm')
  await oniguruma.loadWASM({ data: readFileSync(wasmPath) })
  onigLib = {
    createOnigScanner: (sources: string[]) => oniguruma.createOnigScanner(sources),
    createOnigString: (str: string) => oniguruma.createOnigString(str),
  }
})

function tsDefinition(): IGrammarDefinition {
  return {
    language: 'typescript',
    scopeName: 'source.ts',
    path: './syntaxes/TypeScript.tmLanguage.json',
    location: URI.file(TS_GRAMMAR_PATH),
    sourceExtensionId: 'test',
  }
}

function makeFactory(grammars: GrammarRegistry): TMGrammarFactory {
  return new TMGrammarFactory(
    { readFile: (location) => Promise.resolve(readFileSync(location.fsPath, 'utf8')) },
    grammars,
    Promise.resolve(onigLib),
    () => 42, // fake encoded language id — only asserted back out of metadata
  )
}

// vscode-textmate freezes the passed color map and resolves every referenced
// color by index; index 0 is the ColorId.None slot (never a real color), so
// real colors start at index 1 (VSCode TokenColorIndex).
const TEST_COLOR_MAP = ['#000000', '#111111', '#222222', '#FF0000', '#00FF00']

// tokenizeLine2 merges adjacent ranges with identical metadata, so without a
// theme the whole line collapses into one token. VSCode always applies the
// theme before tokenizing (TextMateTokenizationFeature._updateTheme).
function applyTestTheme(factory: TMGrammarFactory): void {
  factory.setTheme(
    {
      name: 'test-theme',
      settings: [
        { settings: { foreground: '#111111', background: '#222222' } },
        { scope: 'keyword', settings: { foreground: '#FF0000' } },
        { scope: 'string', settings: { foreground: '#00FF00' } },
      ],
    },
    TEST_COLOR_MAP,
  )
}

describe('TMGrammarFactory (real textmate + oniguruma + TypeScript grammar)', () => {
  it('loads the grammar and tokenizes a line with the initial state', async () => {
    const grammars = new GrammarRegistry()
    grammars.registerGrammars([tsDefinition()])
    const factory = makeFactory(grammars)
    applyTestTheme(factory)

    const { grammar, initialState, containsEmbeddedLanguages } = await factory.createGrammar(
      tsDefinition(),
      'typescript',
    )
    expect(containsEmbeddedLanguages).toBe(false)
    expect(initialState.depth).toBe(INITIAL.depth)

    const result = grammar.tokenizeLine2('const x: number = 1', initialState, 500)
    expect(result.stoppedEarly).toBe(false)
    // tokens: [startIndex0, metadata0, startIndex1, metadata1, ...]
    expect(result.tokens.length).toBeGreaterThan(2)
    expect(result.tokens.length % 2).toBe(0)
    expect(result.ruleStack.depth).toBeGreaterThanOrEqual(initialState.depth)
    factory.dispose()
  })

  it('keeps multi-line state across tokenizeLine2 calls (block comments)', async () => {
    const grammars = new GrammarRegistry()
    grammars.registerGrammars([tsDefinition()])
    const factory = makeFactory(grammars)
    const { grammar } = await factory.createGrammar(tsDefinition(), 'typescript')

    const line1 = grammar.tokenizeLine2('/* open', INITIAL, 500)
    expect(line1.ruleStack.depth).toBeGreaterThan(0)
    // Inside the block comment, plain words tokenize as comment (a real grammar
    // would mark them comment.* scope — we assert the stack persisted).
    const line2 = grammar.tokenizeLine2('still comment', line1.ruleStack, 500)
    expect(line2.stoppedEarly).toBe(false)
    factory.dispose()
  })

  it('applies a theme and reports the color map', async () => {
    const grammars = new GrammarRegistry()
    grammars.registerGrammars([tsDefinition()])
    const factory = makeFactory(grammars)

    // vscode-textmate freezes the passed color map and resolves every
    // referenced color by index; index 0 is the ColorId.None slot (never a
    // real color), so real colors start at index 1 (VSCode TokenColorIndex).
    applyTestTheme(factory)
    expect(factory.getColorMap()).toEqual(TEST_COLOR_MAP)

    // A keyword token must carry a foreground color id (non-zero) once themed.
    const { grammar } = await factory.createGrammar(tsDefinition(), 'typescript')
    const result: ReturnType<IGrammar['tokenizeLine2']> = grammar.tokenizeLine2(
      'const x = "s"',
      INITIAL,
      500,
    )
    const metadatas: number[] = []
    for (let i = 0; i < result.tokens.length >>> 1; i++) {
      metadatas.push(result.tokens[(i << 1) + 1]!)
    }
    const foregrounds = metadatas.map((m) => (m & 0b11111111_10000000_00000000) >>> 15)
    expect(foregrounds.some((f) => f > 0)).toBe(true)
    factory.dispose()
  })

  it('throws for an unknown scope and survives it for the next load', async () => {
    const grammars = new GrammarRegistry()
    grammars.registerGrammars([tsDefinition()])
    const factory = makeFactory(grammars)
    await expect(
      factory.createGrammar({ ...tsDefinition(), scopeName: 'source.nonexistent' }, 'typescript'),
    ).rejects.toThrow('source.nonexistent')
    // The registry still works afterwards.
    await expect(factory.createGrammar(tsDefinition(), 'typescript')).resolves.toBeDefined()
    factory.dispose()
  })

  it('passes the original remote-ssh URI to readFile instead of folding to a local fsPath', async () => {
    const location = URI.parse(
      'remote-ssh://wsl+Ubuntu/home/xiao/.universe-editor-server/ext/textmate-grammars/syntaxes/ignore.tmLanguage.json',
    )
    const definition: IGrammarDefinition = {
      language: 'ignore',
      scopeName: 'source.ignore',
      path: './syntaxes/ignore.tmLanguage.json',
      location,
      sourceExtensionId: 'test',
    }
    const readFile = vi.fn((_resource: URI) =>
      Promise.resolve(
        JSON.stringify({
          name: 'Ignore',
          scopeName: 'source.ignore',
          patterns: [{ include: '#comment' }],
          repository: { comment: { name: 'comment.line.number-sign.ignore', match: '#.*$' } },
        }),
      ),
    )
    const grammars = new GrammarRegistry()
    grammars.registerGrammars([definition])
    const factory = new TMGrammarFactory({ readFile }, grammars, Promise.resolve(onigLib), () => 42)

    await factory.createGrammar(definition, 'ignore')

    expect(readFile).toHaveBeenCalledTimes(1)
    const received = readFile.mock.calls[0]![0]
    expect(received.scheme).toBe('remote-ssh')
    expect(received.authority).toBe('wsl+Ubuntu')
    expect(received.toString()).toBe(location.toString())
    factory.dispose()
  })
})
