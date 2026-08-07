import { describe, expect, it } from 'vitest'
import {
  composeAiFixPrompt,
  snapshotAiFixArg,
  type AiFixMarker,
  type AiFixModel,
  type AiFixProblem,
} from '../aiFixPrompt.js'

function fakeModel(lines: readonly string[]): AiFixModel {
  return {
    uri: { toString: () => 'file:///ws/src/a.ts' },
    getLineCount: () => lines.length,
    getLineMaxColumn: (line) => (lines[line - 1]?.length ?? 0) + 1,
    getValueInRange: (range) =>
      lines.slice(range.startLineNumber - 1, range.endLineNumber).join('\n'),
    getLanguageId: () => 'typescript',
  }
}

function marker(partial: Partial<AiFixMarker> & { startLineNumber: number }): AiFixMarker {
  return {
    message: 'boom',
    severity: 8,
    startColumn: 3,
    endLineNumber: partial.startLineNumber,
    endColumn: 10,
    ...partial,
  }
}

function problem(partial: Partial<AiFixProblem>): AiFixProblem {
  return {
    message: 'boom',
    severity: 8,
    startLineNumber: 12,
    startColumn: 5,
    endLineNumber: 12,
    endColumn: 9,
    ...partial,
  }
}

describe('snapshotAiFixArg', () => {
  it('snapshots a single marker with a ±3-line window of full lines', () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line${i + 1}`)
    const arg = snapshotAiFixArg(fakeModel(lines), [marker({ startLineNumber: 10 })], 'src/a.ts')

    expect(arg.resource).toBe('file:///ws/src/a.ts')
    expect(arg.contexts).toHaveLength(1)
    const ctx = arg.contexts[0]!
    expect(ctx.relPath).toBe('src/a.ts')
    expect(ctx.startLine).toBe(7)
    expect(ctx.endLine).toBe(13)
    expect(ctx.text).toBe(lines.slice(6, 13).join('\n'))
    expect(ctx.languageId).toBe('typescript')
  })

  it('clamps the window to the file bounds', () => {
    const lines = ['a', 'b', 'c']
    const top = snapshotAiFixArg(fakeModel(lines), [marker({ startLineNumber: 1 })], 'a.ts')
    expect(top.contexts[0]!.startLine).toBe(1)
    expect(top.contexts[0]!.endLine).toBe(3)

    const bottom = snapshotAiFixArg(fakeModel(lines), [marker({ startLineNumber: 3 })], 'a.ts')
    expect(bottom.contexts[0]!.startLine).toBe(1)
    expect(bottom.contexts[0]!.endLine).toBe(3)
  })

  it('merges the line ranges of multiple markers into one context', () => {
    const lines = Array.from({ length: 30 }, (_, i) => `line${i + 1}`)
    const arg = snapshotAiFixArg(
      fakeModel(lines),
      [marker({ startLineNumber: 8 }), marker({ startLineNumber: 20 })],
      'src/a.ts',
    )
    const ctx = arg.contexts[0]!
    expect(ctx.startLine).toBe(5)
    expect(ctx.endLine).toBe(23)
    expect(arg.problems).toHaveLength(2)
  })

  it('truncates snippets past the size cap', () => {
    const lines = Array.from({ length: 200 }, (_, i) => `line${i + 1}-${'x'.repeat(100)}`)
    // Two far-apart markers merge into one ~187-line window (~20k chars).
    const arg = snapshotAiFixArg(
      fakeModel(lines),
      [marker({ startLineNumber: 10 }), marker({ startLineNumber: 190 })],
      'a.ts',
    )
    const text = arg.contexts[0]!.text
    expect(text.length).toBeLessThanOrEqual(4002)
    expect(text.endsWith('…')).toBe(true)
  })

  it('flattens object-shaped marker codes and keeps source', () => {
    const arg = snapshotAiFixArg(
      fakeModel(['x']),
      [
        marker({
          startLineNumber: 1,
          code: { value: 'ts2322' },
          source: 'typescript',
          message: 'Type mismatch',
        }),
      ],
      'a.ts',
    )
    expect(arg.problems[0]).toMatchObject({ code: 'ts2322', source: 'typescript' })
  })

  it('omits source/code when the marker lacks them', () => {
    const arg = snapshotAiFixArg(fakeModel(['x']), [marker({ startLineNumber: 1 })], 'a.ts')
    expect(arg.problems[0]).not.toHaveProperty('source')
    expect(arg.problems[0]).not.toHaveProperty('code')
  })
})

describe('composeAiFixPrompt', () => {
  function argOf(problems: readonly AiFixProblem[]) {
    return {
      resource: 'file:///ws/src/a.ts',
      contexts: [
        {
          uri: 'file:///ws/src/a.ts',
          relPath: 'src/a.ts',
          text: 'code',
          startLine: 1,
          endLine: 3,
          languageId: 'typescript',
        },
      ],
      problems,
    } as const
  }

  it('lists the file, severity, position and message in the text body', () => {
    const arg = argOf([problem({ message: 'Type mismatch', source: 'typescript', code: 'ts2322' })])
    const { text, contexts } = composeAiFixPrompt(arg)
    expect(text).toContain('src/a.ts')
    expect(text).toContain('- Error at 12:5: Type mismatch (ts2322) [typescript]')
    expect(text).toContain('minimal fix')
    expect(contexts).toBe(arg.contexts)
  })

  it('omits the code/source suffixes when absent', () => {
    const { text } = composeAiFixPrompt(argOf([problem({})]))
    const line = text.split('\n').find((l) => l.startsWith('- '))
    expect(line).toBe('- Error at 12:5: boom')
  })

  it('maps severity numbers to labels', () => {
    const { text } = composeAiFixPrompt(
      argOf([
        problem({ severity: 8, message: 'e' }),
        problem({ severity: 4, message: 'w' }),
        problem({ severity: 2, message: 'i' }),
        problem({ severity: 1, message: 'h' }),
      ]),
    )
    expect(text).toContain('- Error at 12:5: e')
    expect(text).toContain('- Warning at 12:5: w')
    expect(text).toContain('- Info at 12:5: i')
    expect(text).toContain('- Hint at 12:5: h')
  })

  it('renders multi-line ranges with both endpoints', () => {
    const { text } = composeAiFixPrompt(argOf([problem({ endLineNumber: 14, endColumn: 3 })]))
    expect(text).toContain('at 12:5-14:3:')
  })

  it('caps the listing at 5 problems and notes the remainder', () => {
    const problems = Array.from({ length: 7 }, (_, i) => problem({ message: `p${i + 1}` }))
    const { text } = composeAiFixPrompt(argOf(problems))
    expect(text).toContain('p5')
    expect(text).not.toContain('p6')
    expect(text).toContain('…and 2 more')
  })
})
