import { describe, expect, it } from 'vitest'
import {
  buildCodeActions,
  computeFixAll,
  fileDirOf,
  filePathOf,
  lintDocument,
  type EslintApi,
  type EslintConstructor,
} from '../eslintRunner.js'

/** Minimal fake ESLint honoring the subset of the API the runner uses. */
function fakeEslint(
  messages: unknown[],
  opts: { output?: string; rulesMeta?: Record<string, unknown> } = {},
): EslintApi {
  return {
    async lintText(_code: string, _o: { filePath: string }) {
      return [
        {
          filePath: _o.filePath,
          messages: messages as never,
          ...(opts.output !== undefined ? { output: opts.output } : {}),
        },
      ]
    },
    getRulesMetaForResults: () => (opts.rulesMeta ?? {}) as never,
  }
}

describe('lintDocument', () => {
  it('maps 1-based ESLint messages to 0-based LSP diagnostics with a rule-docs link', async () => {
    const eslint = fakeEslint(
      [
        {
          ruleId: 'no-unused-vars',
          severity: 2,
          message: "'x' is defined but never used.",
          line: 1,
          column: 7,
          endLine: 1,
          endColumn: 8,
        },
      ],
      { rulesMeta: { 'no-unused-vars': { docs: { url: 'https://eslint.org/no-unused-vars' } } } },
    )
    const { diagnostics } = await lintDocument(eslint, 'const x = 1', '/w/a.js')
    expect(diagnostics).toHaveLength(1)
    const d = diagnostics[0]!
    expect(d.range).toEqual({
      start: { line: 0, character: 6 },
      end: { line: 0, character: 7 },
    })
    expect(d.severity).toBe(1) // error (ESLint 2 → LSP 1)
    expect(d.code).toBe('no-unused-vars')
    expect(d.source).toBe('eslint')
    expect(d.codeDescription).toEqual({ href: 'https://eslint.org/no-unused-vars' })
  })

  it('maps warning severity and tolerates missing end position', async () => {
    const eslint = fakeEslint([
      { ruleId: 'semi', severity: 1, message: 'Missing semicolon.', line: 2, column: 3 },
    ])
    const { diagnostics } = await lintDocument(eslint, 'a\nbb', '/w/a.js')
    const d = diagnostics[0]!
    expect(d.severity).toBe(2) // warning (ESLint 1 → LSP 2)
    expect(d.range).toEqual({
      start: { line: 1, character: 2 },
      end: { line: 1, character: 2 },
    })
  })
})

describe('buildCodeActions', () => {
  const text = 'const x = 1\nconsole.log( x )\n'
  const messages = [
    {
      ruleId: 'no-extra-parens',
      severity: 1,
      message: 'x',
      line: 2,
      column: 13,
      fix: { range: [24, 25] as const, text: '' },
      suggestions: [{ desc: 'Remove the spaces', fix: { range: [23, 24] as const, text: '' } }],
    },
  ]

  it('emits a quick fix, a suggestion, and a disable-line action for a fixable message', () => {
    const actions = buildCodeActions(text, messages as never, {
      start: { line: 1 },
      end: { line: 1 },
    })
    const titles = actions.map((a) => a.title)
    expect(titles).toContain('Fix this no-extra-parens problem')
    expect(titles).toContain('Remove the spaces')
    expect(titles).toContain('Disable no-extra-parens for this line')
    // The quick fix is preferred.
    expect(actions.find((a) => a.title.startsWith('Fix this'))?.isPreferred).toBe(true)
  })

  it('inserts the disable comment above the message line with matching indentation', () => {
    const indented = '  const y = 2\n'
    const msg = [{ ruleId: 'no-unused-vars', severity: 1, message: 'y', line: 1, column: 9 }]
    const actions = buildCodeActions(indented, msg as never, {
      start: { line: 0 },
      end: { line: 0 },
    })
    const disable = actions.find((a) => a.title.startsWith('Disable'))!
    expect(disable.edits[0]!.newText).toBe('  // eslint-disable-next-line no-unused-vars\n')
    expect(disable.edits[0]!.range).toEqual({
      start: { line: 0, character: 0 },
      end: { line: 0, character: 0 },
    })
  })

  it('excludes messages outside the requested range', () => {
    const actions = buildCodeActions(text, messages as never, {
      start: { line: 0 },
      end: { line: 0 },
    })
    expect(actions).toHaveLength(0)
  })
})

describe('computeFixAll', () => {
  it('returns a single full-document edit when ESLint autofix changes the text', async () => {
    const original = 'var a=1'
    const fixed = 'var a = 1;\n'
    const Ctor = (function () {
      return function () {
        return fakeEslint([], { output: fixed })
      }
    })() as unknown as EslintConstructor
    const edits = await computeFixAll(Ctor, {}, original, '/w/a.js')
    expect(edits).toHaveLength(1)
    expect(edits[0]!.newText).toBe(fixed)
    expect(edits[0]!.range).toEqual({
      start: { line: 0, character: 0 },
      end: { line: 0, character: 7 },
    })
  })

  it('returns no edits when autofix produces no change', async () => {
    const text = 'clean();\n'
    const Ctor = (function () {
      return function () {
        return fakeEslint([]) // no output → nothing changed
      }
    })() as unknown as EslintConstructor
    expect(await computeFixAll(Ctor, {}, text, '/w/a.js')).toEqual([])
  })
})

describe('uri helpers', () => {
  const norm = (p: string | undefined) => p?.replace(/\\/g, '/')

  it('fileDirOf returns the parent directory for a file uri', () => {
    expect(norm(fileDirOf('file:///w/pkg/a.ts'))).toBe('/w/pkg')
  })

  it('fileDirOf returns undefined for non-file schemes', () => {
    expect(fileDirOf('untitled:foo')).toBeUndefined()
  })

  it('filePathOf returns the fsPath for a file uri', () => {
    expect(norm(filePathOf('file:///w/a.ts'))).toBe('/w/a.ts')
  })
})
