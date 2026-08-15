/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  Integration pin for the hand-written TOML grammar: loads the real file
 *  through vscode-textmate + oniguruma and asserts the scopes every TOML
 *  construct must carry. A broken regex or mis-scoped pattern fails here
 *  before any editor opens an uncolored (or mis-colored) .toml file.
 *--------------------------------------------------------------------------------------------*/

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { INITIAL, type IGrammar, type IOnigLib, type StateStack } from 'vscode-textmate'
import { beforeAll, describe, expect, it } from 'vitest'
import { GrammarRegistry, type IGrammarDefinition } from '../grammarRegistry.js'
import { TMGrammarFactory } from '../tmGrammarFactory.js'
import { URI } from '@universe-editor/platform'

const require = createRequire(import.meta.url)
const repoRoot = join(fileURLToPath(import.meta.url), '../../../../../../../..')
const TOML_GRAMMAR_PATH = join(
  repoRoot,
  'extensions/textmate-grammars/syntaxes/toml.tmLanguage.json',
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

function tomlDefinition(): IGrammarDefinition {
  return {
    language: 'toml',
    scopeName: 'source.toml',
    path: './syntaxes/toml.tmLanguage.json',
    location: URI.file(TOML_GRAMMAR_PATH),
    sourceExtensionId: 'test',
  }
}

async function loadGrammar(): Promise<IGrammar> {
  const grammars = new GrammarRegistry()
  grammars.registerGrammars([tomlDefinition()])
  const factory = new TMGrammarFactory(
    { readFile: (location) => Promise.resolve(readFileSync(location.fsPath, 'utf8')) },
    grammars,
    Promise.resolve(onigLib),
    () => 42,
  )
  const { grammar } = await factory.createGrammar(tomlDefinition(), 'toml')
  factory.dispose()
  return grammar
}

/** Tokenize a whole document, returning each line's tokens with scope stacks. */
function tokenize(grammar: IGrammar, text: string): string[][][] {
  let state: StateStack | null = INITIAL
  return text.split('\n').map((line) => {
    const result = grammar.tokenizeLine(line, state, 500)
    state = result.ruleStack
    return result.tokens.map((t) => t.scopes)
  })
}

function lineHasScope(lines: string[][][], lineIndex: number, scope: string): boolean {
  return lines[lineIndex]!.some((scopes) => scopes.includes(scope))
}

describe('TOML grammar (real textmate + oniguruma)', () => {
  it('scopes table headers, dotted keys and array-of-tables', async () => {
    const grammar = await loadGrammar()
    const lines = tokenize(grammar, ['[package]', '[[bin]]', '[a.b."c d"]'].join('\n'))
    expect(lineHasScope(lines, 0, 'entity.name.section.table.toml')).toBe(true)
    expect(lineHasScope(lines, 1, 'punctuation.definition.table.array.toml')).toBe(true)
    expect(lineHasScope(lines, 2, 'punctuation.separator.dot.toml')).toBe(true)
  })

  it('scopes keys, assignment and basic values', async () => {
    const grammar = await loadGrammar()
    const lines = tokenize(
      grammar,
      ['name = "uni\\u0069verse"', "path = 'C:\\\\literal'", 'debug = true', 'pi = 3.14e-2'].join(
        '\n',
      ),
    )
    expect(lineHasScope(lines, 0, 'variable.other.key.toml')).toBe(true)
    expect(lineHasScope(lines, 0, 'keyword.operator.assignment.toml')).toBe(true)
    expect(lineHasScope(lines, 0, 'string.quoted.double.toml')).toBe(true)
    expect(lineHasScope(lines, 0, 'constant.character.escape.toml')).toBe(true)
    expect(lineHasScope(lines, 1, 'string.quoted.single.toml')).toBe(true)
    expect(lineHasScope(lines, 2, 'constant.language.boolean.toml')).toBe(true)
    expect(lineHasScope(lines, 3, 'constant.numeric.float.toml')).toBe(true)
  })

  it('scopes integer bases and dates before plain numbers', async () => {
    const grammar = await loadGrammar()
    const lines = tokenize(
      grammar,
      [
        'a = 0xDEAD_BEEF',
        'b = 0o755',
        'c = 0b1010',
        'd = 1_000',
        'e = 1979-05-27T07:32:00Z',
        'f = 1979-05-27',
        'g = 07:32:00',
      ].join('\n'),
    )
    expect(lineHasScope(lines, 0, 'constant.numeric.hex.toml')).toBe(true)
    expect(lineHasScope(lines, 1, 'constant.numeric.octal.toml')).toBe(true)
    expect(lineHasScope(lines, 2, 'constant.numeric.binary.toml')).toBe(true)
    expect(lineHasScope(lines, 3, 'constant.numeric.integer.toml')).toBe(true)
    expect(lineHasScope(lines, 4, 'constant.numeric.datetime.offset.toml')).toBe(true)
    expect(lineHasScope(lines, 5, 'constant.numeric.date.toml')).toBe(true)
    expect(lineHasScope(lines, 6, 'constant.numeric.time.toml')).toBe(true)
    // A date must not be partially eaten as an integer.
    expect(lineHasScope(lines, 5, 'constant.numeric.integer.toml')).toBe(false)
  })

  it('keeps multiline strings, arrays and inline tables across lines', async () => {
    const grammar = await loadGrammar()
    const lines = tokenize(
      grammar,
      [
        'text = """',
        'still a string # not a comment',
        '"""',
        'list = [',
        '  1, # trailing comment',
        '  [2, 3],',
        ']',
        'point = { x = 1, y = 2 }',
      ].join('\n'),
    )
    expect(lineHasScope(lines, 1, 'string.quoted.double.toml')).toBe(true)
    expect(lineHasScope(lines, 1, 'comment.line.number-sign.toml')).toBe(false)
    expect(lineHasScope(lines, 4, 'comment.line.number-sign.toml')).toBe(true)
    expect(lineHasScope(lines, 5, 'meta.structure.array.toml')).toBe(true)
    expect(lineHasScope(lines, 7, 'meta.structure.table.inline.toml')).toBe(true)
    expect(lineHasScope(lines, 7, 'variable.other.key.toml')).toBe(true)
  })

  it('scopes trailing comments after values', async () => {
    const grammar = await loadGrammar()
    const lines = tokenize(grammar, 'a = 1 # one')
    expect(lineHasScope(lines, 0, 'constant.numeric.integer.toml')).toBe(true)
    expect(lineHasScope(lines, 0, 'comment.line.number-sign.toml')).toBe(true)
  })
})
