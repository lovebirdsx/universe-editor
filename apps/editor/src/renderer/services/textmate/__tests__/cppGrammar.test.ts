/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  Regression pin: `cpp` must be tokenized by the full source.cpp grammar, not
 *  by the source.cpp.embedded.macro fragment. The fragment's documentation
 *  comment rule ends at every newline (macro line-continuation semantics), so
 *  binding it to `cpp` broke document comments after their first line.
 *  The manifest invariant below also keeps the fragment language-less: grammar
 *  selection is first-wins, so a stray `language: cpp` on the fragment would
 *  silently take over again.
 *--------------------------------------------------------------------------------------------*/

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { URI } from '@universe-editor/platform'
import { INITIAL, type IGrammar, type IOnigLib, type StateStack } from 'vscode-textmate'
import { beforeAll, describe, expect, it } from 'vitest'
import { GrammarRegistry, type IGrammarDefinition } from '../grammarRegistry.js'
import { TMGrammarFactory } from '../tmGrammarFactory.js'

const require = createRequire(import.meta.url)
const repoRoot = join(fileURLToPath(import.meta.url), '../../../../../../../..')
const grammarExtensionRoot = join(repoRoot, 'extensions/textmate-grammars')

interface ManifestGrammar {
  language?: string
  scopeName: string
  path: string
}

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

/** Definitions exactly as the built-in grammar extension contributes them. */
function manifestDefinitions(): IGrammarDefinition[] {
  const manifest = JSON.parse(readFileSync(join(grammarExtensionRoot, 'package.json'), 'utf8')) as {
    contributes: { grammars: ManifestGrammar[] }
  }
  return manifest.contributes.grammars.map((grammar) => ({
    ...grammar,
    location: URI.file(join(grammarExtensionRoot, grammar.path)),
    sourceExtensionId: 'textmate-grammars',
  }))
}

async function loadCppGrammar(): Promise<IGrammar> {
  const definitions = manifestDefinitions()
  const cppDefinition = definitions.find((definition) => definition.language === 'cpp')
  expect(cppDefinition).toBeDefined()
  const grammars = new GrammarRegistry()
  grammars.registerGrammars(definitions)
  const factory = new TMGrammarFactory(
    { readFile: (location) => Promise.resolve(readFileSync(location.fsPath, 'utf8')) },
    grammars,
    Promise.resolve(onigLib),
    () => 42,
  )
  const { grammar } = await factory.createGrammar(cppDefinition!, 'cpp')
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

describe('C++ grammar (real textmate + oniguruma)', () => {
  it('binds cpp to source.cpp and keeps the embedded macro fragment language-less', () => {
    const definitions = manifestDefinitions()
    const cppDefinitions = definitions.filter((definition) => definition.language === 'cpp')

    expect(cppDefinitions.map((definition) => definition.scopeName)).toEqual(['source.cpp'])
    const macroFragment = definitions.find(
      (definition) => definition.scopeName === 'source.cpp.embedded.macro',
    )
    expect(macroFragment).toBeDefined()
    expect(macroFragment!.language).toBeUndefined()
  })

  it('keeps documentation block comments scoped across lines', async () => {
    const grammar = await loadCppGrammar()
    const lines = tokenize(
      grammar,
      ['/**', ' * alpha', ' * beta', ' */', 'int main() { return 0; }'].join('\n'),
    )

    for (let line = 0; line <= 3; line++) {
      expect(lineHasScope(lines, line, 'comment.block.documentation.cpp')).toBe(true)
    }
    expect(lineHasScope(lines, 3, 'punctuation.definition.comment.end.documentation.cpp')).toBe(
      true,
    )
    // The fragment grammar reads `* alpha` as a multiplication operator; the
    // full grammar keeps the whole line inside the comment.
    expect(lineHasScope(lines, 1, 'keyword.operator.arithmetic.cpp')).toBe(false)
    expect(lineHasScope(lines, 4, 'storage.type.primitive.cpp')).toBe(true)
  })
})
