import type { SessionUpdate } from '@agentclientprotocol/sdk'
import { describe, expect, it } from 'vitest'
import { computeLineDiff, parseAnsi, readTerminalOutput, truncateToolTextBlock } from '../index.js'

describe('acp-view-model', () => {
  it('parses ANSI SGR runs and strips other escapes', () => {
    expect(parseAnsi('\x1b[31mred\x1b[0m plain')).toStrictEqual([
      { text: 'red', fg: 'var(--acp-ansi-red)' },
      { text: ' plain' },
    ])
  })

  it('diffs line changes', () => {
    expect(computeLineDiff('a\nb', 'a\nc')).toStrictEqual([
      { kind: 'ctx', text: 'a' },
      { kind: 'del', text: 'b' },
      { kind: 'add', text: 'c' },
    ])
  })

  it('truncates oversized tool text with head and tail', () => {
    const text = 'x'.repeat(300 * 1024)
    const out = truncateToolTextBlock(text)
    expect(out.length).toBeLessThan(text.length)
    expect(out).toContain('chars truncated')
  })

  it('reads out-of-band terminal output from _meta', () => {
    expect(
      readTerminalOutput({
        _meta: { terminal_output_delta: { data: 'chunk' } },
      } as unknown as SessionUpdate),
    ).toStrictEqual({ data: 'chunk', mode: 'append' })
    expect(
      readTerminalOutput({
        _meta: { terminal_output: { data: 'full' } },
      } as unknown as SessionUpdate),
    ).toStrictEqual({ data: 'full', mode: 'replace' })
    expect(readTerminalOutput({} as SessionUpdate)).toBeUndefined()
  })
})
