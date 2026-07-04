/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Tests for deriveToolCallDisplay — friendly-title normalization.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import type { AcpToolCall } from '../../../services/acp/acpSessionService.js'
import { deriveToolCallDisplay } from '../toolCallDisplay.js'

function makeCall(overrides: Partial<AcpToolCall>): AcpToolCall {
  return {
    id: 't1',
    title: 'raw title',
    kind: 'other',
    status: 'completed',
    text: '',
    blocks: [],
    diffs: [],
    ...overrides,
  }
}

describe('deriveToolCallDisplay', () => {
  it('promotes a Bash description to the title and demotes the command', () => {
    const d = deriveToolCallDisplay(
      makeCall({
        kind: 'execute',
        title: 'git status',
        rawInput: { command: 'git status', description: '查看工作区状态' },
      }),
    )
    expect(d.title).toBe('查看工作区状态')
    expect(d.subtitle).toBe('git status')
  })

  it('falls back to the command as title when no description (codex)', () => {
    const d = deriveToolCallDisplay(
      makeCall({ kind: 'execute', title: 'ls -la', rawInput: { command: 'ls -la' } }),
    )
    expect(d.title).toBe('ls -la')
    expect(d.subtitle).toBeUndefined()
  })

  it('keeps the raw title when execute has no rawInput at all', () => {
    const d = deriveToolCallDisplay(makeCall({ kind: 'execute', title: 'Terminal' }))
    expect(d.title).toBe('Terminal')
    expect(d.subtitle).toBeUndefined()
  })

  it('friendly-titles a search and keeps the fragment as subtitle', () => {
    const d = deriveToolCallDisplay(
      makeCall({
        kind: 'search',
        title: 'grep -i "foo" src',
        rawInput: { pattern: 'foo', path: 'src' },
      }),
    )
    expect(d.title).toBe('搜索 “foo”')
    expect(d.subtitle).toBe('grep -i "foo" src')
  })

  it('leaves already-friendly tools untouched', () => {
    const d = deriveToolCallDisplay(
      makeCall({ kind: 'edit', title: 'Edit src/foo.ts', rawInput: { file_path: 'src/foo.ts' } }),
    )
    expect(d.title).toBe('Edit src/foo.ts')
    expect(d.subtitle).toBeUndefined()
  })
})
