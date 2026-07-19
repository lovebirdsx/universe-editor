/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Tests for deriveToolCallDisplay — friendly-title normalization.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import type { AcpToolCall } from '../../../services/acp/acpSessionService.js'
import {
  DEFAULT_KEEP_PLANNING_MESSAGE,
  deriveToolCallDisplay,
  humanizeMcpTool,
  isKeepPlanning,
  keepPlanningFeedback,
  tryPrettyJson,
} from '../toolCallDisplay.js'

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

  it('humanizes an MCP tool call to a Title Case title', () => {
    const d = deriveToolCallDisplay(
      makeCall({
        kind: 'read',
        title: 'mcp_universe-editor_ue_create_session',
        mcpServer: 'universe-editor',
        mcpTool: 'ue_create_session',
      }),
    )
    expect(d.title).toBe('Create Session')
    expect(d.subtitle).toBeUndefined()
  })

  it('falls back to raw title when MCP tool segment is missing', () => {
    const d = deriveToolCallDisplay(makeCall({ kind: 'other', title: 'raw name', mcpServer: 'fs' }))
    expect(d.title).toBe('raw name')
  })

  it('shows a neutral "keep planning" title for a rejected ExitPlanMode', () => {
    const d = deriveToolCallDisplay(
      makeCall({ kind: 'switch_mode', title: 'Ready to code?', status: 'failed' }),
    )
    expect(d.title).toBe('已继续规划')
  })

  it('keeps the raw title for a switch_mode that was NOT rejected', () => {
    const d = deriveToolCallDisplay(
      makeCall({ kind: 'switch_mode', title: 'Ready to code?', status: 'completed' }),
    )
    expect(d.title).toBe('Ready to code?')
  })
})

describe('isKeepPlanning', () => {
  it('is true only for a failed switch_mode', () => {
    expect(isKeepPlanning(makeCall({ kind: 'switch_mode', status: 'failed' }))).toBe(true)
    expect(isKeepPlanning(makeCall({ kind: 'switch_mode', status: 'completed' }))).toBe(false)
    expect(isKeepPlanning(makeCall({ kind: 'execute', status: 'failed' }))).toBe(false)
  })
})

describe('keepPlanningFeedback', () => {
  it('returns the user steering note when the deny body is not the default', () => {
    expect(
      keepPlanningFeedback(
        makeCall({ kind: 'switch_mode', status: 'failed', text: '  先不做了  ' }),
      ),
    ).toBe('先不做了')
  })

  it('suppresses the default (no-note) reject body', () => {
    expect(
      keepPlanningFeedback(
        makeCall({ kind: 'switch_mode', status: 'failed', text: DEFAULT_KEEP_PLANNING_MESSAGE }),
      ),
    ).toBeUndefined()
  })

  it('strips the fork error fence and suppresses the fenced default body', () => {
    expect(
      keepPlanningFeedback(
        makeCall({
          kind: 'switch_mode',
          status: 'failed',
          text: '```\nUser rejected request to exit plan mode.\n```',
        }),
      ),
    ).toBeUndefined()
  })

  it('strips the fork error fence around a real steering note', () => {
    expect(
      keepPlanningFeedback(
        makeCall({ kind: 'switch_mode', status: 'failed', text: '```\n先不做了\n```' }),
      ),
    ).toBe('先不做了')
  })

  it('returns undefined for empty body or non-keep-planning calls', () => {
    expect(
      keepPlanningFeedback(makeCall({ kind: 'switch_mode', status: 'failed', text: '' })),
    ).toBeUndefined()
    expect(
      keepPlanningFeedback(
        makeCall({ kind: 'switch_mode', status: 'completed', text: '先不做了' }),
      ),
    ).toBeUndefined()
  })
})

describe('humanizeMcpTool', () => {
  it('strips a short vendor prefix and Title Cases the rest', () => {
    expect(humanizeMcpTool('ue_create_session')).toBe('Create Session')
  })

  it('handles a plain snake_case tool without a prefix', () => {
    expect(humanizeMcpTool('read_object')).toBe('Read Object')
  })

  it('keeps a single-word tool', () => {
    expect(humanizeMcpTool('query')).toBe('Query')
  })

  it('does not strip when stripping would empty the label', () => {
    expect(humanizeMcpTool('ls')).toBe('Ls')
  })
})

describe('tryPrettyJson', () => {
  it('pretty-prints a JSON object', () => {
    expect(tryPrettyJson('{"a":1,"b":2}')).toBe('{\n  "a": 1,\n  "b": 2\n}')
  })

  it('pretty-prints a JSON array', () => {
    expect(tryPrettyJson('[1,2]')).toBe('[\n  1,\n  2\n]')
  })

  it('returns undefined for plain text', () => {
    expect(tryPrettyJson('ok')).toBeUndefined()
  })

  it('returns undefined for text that only looks like JSON', () => {
    expect(tryPrettyJson('{not json}')).toBeUndefined()
  })

  it('returns undefined for empty input', () => {
    expect(tryPrettyJson('   ')).toBeUndefined()
  })
})
