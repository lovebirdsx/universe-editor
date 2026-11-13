import { describe, expect, it } from 'vitest'
import { isSafeRelativePath, parseVerdict, validateActions } from '../verdict.js'
import type { TriggerVerdict, TriggerVerdictAction } from '../types.js'

const action = (overrides: Partial<TriggerVerdictAction> = {}): TriggerVerdictAction => ({
  type: 'swarm.vote',
  target: '100801',
  detail: 'up',
  ...overrides,
})

const verdict = (overrides: Partial<TriggerVerdict> = {}): TriggerVerdict => ({
  verdict: 'auto-approve',
  summary: '看过没问题',
  actions: [],
  ...overrides,
})

const options = {
  allowedActions: ['swarm.vote', 'swarm.comment', 'swarm.approve'] as const,
  eventTarget: '100801',
  approveConfirmed: true,
}

describe('parseVerdict', () => {
  it('parses a complete verdict', () => {
    const raw = JSON.stringify({
      verdict: 'auto-approve',
      summary: '没问题',
      reportPath: 'report.md',
      actions: [{ type: 'swarm.vote', target: '100801', detail: 'up' }],
    })
    expect(parseVerdict(raw)).toEqual({
      ok: true,
      verdict: {
        verdict: 'auto-approve',
        summary: '没问题',
        reportPath: 'report.md',
        actions: [{ type: 'swarm.vote', target: '100801', detail: 'up' }],
      },
    })
  })

  it('defaults summary to an empty string and truncates long ones', () => {
    const missing = parseVerdict('{"verdict":"info"}')
    expect(missing.ok && missing.verdict.summary).toBe('')
    const long = parseVerdict(JSON.stringify({ verdict: 'info', summary: 'y'.repeat(250) }))
    expect(long.ok && long.verdict.summary).toHaveLength(200)
  })

  it('rejects malformed files', () => {
    for (const raw of ['', '   ', 'not json', '[]', '"x"']) {
      expect(parseVerdict(raw).ok, raw).toBe(false)
    }
    expect(parseVerdict('{"verdict":"maybe"}').ok).toBe(false)
    expect(parseVerdict(JSON.stringify({ verdict: 'info', summary: 1 })).ok).toBe(false)
    expect(parseVerdict(JSON.stringify({ verdict: 'info', actions: 'none' })).ok).toBe(false)
    expect(parseVerdict('{"verdict":"info","actions":[{"target":"1"}]}').ok).toBe(false)
    expect(parseVerdict('{"verdict":"info","actions":[{"type":"swarm.vote"}]}').ok).toBe(false)
    expect(
      parseVerdict('{"verdict":"info","actions":[{"type":"swarm.vote","target":"1","detail":2}]}')
        .ok,
    ).toBe(false)
  })

  it('only accepts relative report paths without ".."', () => {
    expect(isSafeRelativePath('report.md')).toBe(true)
    expect(isSafeRelativePath('reports\\sub\\a.md')).toBe(true)
    expect(isSafeRelativePath('my report.md')).toBe(true)
    expect(isSafeRelativePath('./report.md')).toBe(true)
    for (const path of [
      '/abs.md',
      'C:/abs.md',
      '\\\\server\\x',
      '../a.md',
      'a/../../b.md',
      '',
      // Windows silently strips trailing dots/spaces and treats `:` as ADS/drive.
      'report.md.',
      'a/b.md. ',
      'trailing /b.md',
      'stream:name',
      'a\\.. /b.md',
    ]) {
      expect(isSafeRelativePath(path), path).toBe(false)
    }
    expect(parseVerdict(JSON.stringify({ verdict: 'info', reportPath: '../a.md' })).ok).toBe(false)
    expect(parseVerdict(JSON.stringify({ verdict: 'info', reportPath: 'a:b.md' })).ok).toBe(false)
  })
})

describe('validateActions', () => {
  it('keeps valid auto-approve actions', () => {
    const input = verdict({
      actions: [
        action(),
        action({ type: 'swarm.comment', detail: ' 看起来不错 ' }),
        action({ type: 'swarm.approve' }),
      ],
    })
    expect(validateActions(input, options)).toEqual({ verdict: input, rejected: [] })
  })

  it('never executes actions for non-auto-approve verdicts', () => {
    const input = verdict({ verdict: 'escalate', actions: [action()] })
    expect(validateActions(input, options)).toEqual({
      verdict: { ...input, actions: [] },
      rejected: [],
    })
  })

  it('downgrades when the action type is not allowed', () => {
    const result = validateActions(verdict({ actions: [action({ type: 'swarm.approve' })] }), {
      ...options,
      allowedActions: ['swarm.vote'],
    })
    expect(result.verdict.verdict).toBe('escalate')
    expect(result.verdict.actions).toEqual([])
    expect(result.rejected).toHaveLength(1)
    expect(result.rejected[0]?.reason).toContain('允许列表')
    expect(result.verdict.summary).toContain('看过没问题')
  })

  it('rejects a target that does not match the event', () => {
    const result = validateActions(verdict({ actions: [action({ target: '999' })] }), options)
    expect(result.rejected[0]?.reason).toContain('目标')
  })

  it('skips the target guard when no event target is known', () => {
    const input = verdict({ actions: [action({ target: '999' })] })
    expect(
      validateActions(input, {
        allowedActions: ['swarm.vote', 'swarm.comment', 'swarm.approve'],
        approveConfirmed: true,
      }),
    ).toEqual({ verdict: input, rejected: [] })
  })

  it('validates vote direction', () => {
    const result = validateActions(verdict({ actions: [action({ detail: 'sideways' })] }), options)
    expect(result.rejected[0]?.reason).toContain('up 或 down')
    expect(
      validateActions(verdict({ actions: [{ type: 'swarm.vote', target: '100801' }] }), options)
        .rejected,
    ).toHaveLength(1)
  })

  it('validates comment body length', () => {
    const empty = validateActions(
      verdict({ actions: [action({ type: 'swarm.comment', detail: '   ' })] }),
      options,
    )
    expect(empty.rejected[0]?.reason).toContain('不能为空')
    const tooLong = validateActions(
      verdict({ actions: [action({ type: 'swarm.comment', detail: 'z'.repeat(4001) })] }),
      options,
    )
    expect(tooLong.rejected[0]?.reason).toContain('4000')
  })

  it('requires confirmation for auto approve', () => {
    const result = validateActions(verdict({ actions: [action({ type: 'swarm.approve' })] }), {
      ...options,
      approveConfirmed: false,
    })
    expect(result.verdict.verdict).toBe('escalate')
    expect(result.rejected[0]?.reason).toContain('未确认')
  })

  it('collects every rejected action', () => {
    const result = validateActions(
      verdict({
        actions: [
          action({ detail: 'sideways' }),
          action({ type: 'swarm.comment', detail: '' }),
          action({ type: 'swarm.approve' }),
        ],
      }),
      { ...options, approveConfirmed: false },
    )
    expect(result.rejected).toHaveLength(3)
    expect(result.verdict.verdict).toBe('escalate')
  })
})
