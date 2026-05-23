/*---------------------------------------------------------------------------------------------
 *  Tests for parseCommandWrappers — the slash-command artifact parser used by
 *  MessageContent to keep XML wrappers out of the chat UI.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import { parseCommandWrappers } from '../commandWrapper.js'

describe('parseCommandWrappers', () => {
  it('returns empty array for empty input', () => {
    expect(parseCommandWrappers('')).toEqual([])
  })

  it('passes plain text through as a single text segment', () => {
    expect(parseCommandWrappers('hello world')).toEqual([{ type: 'text', text: 'hello world' }])
  })

  it('parses a single invocation with all four tags', () => {
    const input =
      '<command-name>/model</command-name>\n' +
      '<command-message>model</command-message>\n' +
      '<command-args>default</command-args>\n' +
      '<local-command-stdout>Set model to claude-sonnet-4-6</local-command-stdout>'
    expect(parseCommandWrappers(input)).toEqual([
      {
        type: 'command',
        invocation: {
          name: '/model',
          message: 'model',
          args: 'default',
          stdout: 'Set model to claude-sonnet-4-6',
        },
      },
    ])
  })

  it('tolerates missing optional tags (only name present)', () => {
    expect(parseCommandWrappers('<command-name>/clear</command-name>')).toEqual([
      { type: 'command', invocation: { name: '/clear' } },
    ])
  })

  it('tolerates missing args (no-argument slash command)', () => {
    const input =
      '<command-name>/clear</command-name>\n' +
      '<command-message>clear</command-message>\n' +
      '<local-command-stdout>Cleared</local-command-stdout>'
    expect(parseCommandWrappers(input)).toEqual([
      {
        type: 'command',
        invocation: { name: '/clear', message: 'clear', stdout: 'Cleared' },
      },
    ])
  })

  it('handles optional tags appearing in non-default order', () => {
    const input =
      '<command-name>/foo</command-name>' +
      '<local-command-stdout>out</local-command-stdout>' +
      '<command-args>bar</command-args>'
    expect(parseCommandWrappers(input)).toEqual([
      {
        type: 'command',
        invocation: { name: '/foo', args: 'bar', stdout: 'out' },
      },
    ])
  })

  it('preserves prose before, between, and after invocations', () => {
    const input =
      'pre\n' +
      '<command-name>/a</command-name>\n' +
      'middle\n' +
      '<command-name>/b</command-name>\n' +
      'post'
    expect(parseCommandWrappers(input)).toEqual([
      { type: 'text', text: 'pre\n' },
      { type: 'command', invocation: { name: '/a' } },
      { type: 'text', text: '\nmiddle\n' },
      { type: 'command', invocation: { name: '/b' } },
      { type: 'text', text: '\npost' },
    ])
  })

  it('parses multiple back-to-back invocations with no prose between', () => {
    const input =
      '<command-name>/a</command-name>' +
      '<command-args>one</command-args>' +
      '<command-name>/b</command-name>'
    expect(parseCommandWrappers(input)).toEqual([
      { type: 'command', invocation: { name: '/a', args: 'one' } },
      { type: 'command', invocation: { name: '/b' } },
    ])
  })

  it('treats stdout content as opaque (does not recurse into < characters)', () => {
    const input =
      '<command-name>/grep</command-name>' +
      '<local-command-stdout>matched &lt;div&gt; tags and a literal < char</local-command-stdout>'
    expect(parseCommandWrappers(input)).toEqual([
      {
        type: 'command',
        invocation: {
          name: '/grep',
          stdout: 'matched &lt;div&gt; tags and a literal < char',
        },
      },
    ])
  })

  it('leaves an unclosed <command-name> tag as plain text', () => {
    const input = 'before <command-name>/oops without close'
    expect(parseCommandWrappers(input)).toEqual([{ type: 'text', text: input }])
  })

  it('drops a single unclosed optional tag but still emits the command', () => {
    const input =
      '<command-name>/foo</command-name>' + '<command-args>missing-close-tag-content-here'
    const segments = parseCommandWrappers(input)
    expect(segments[0]).toEqual({ type: 'command', invocation: { name: '/foo' } })
    expect(segments[1]).toEqual({
      type: 'text',
      text: '<command-args>missing-close-tag-content-here',
    })
  })

  it('trims surrounding whitespace from the command name', () => {
    const input = '<command-name>  /spaced  </command-name>'
    expect(parseCommandWrappers(input)).toEqual([
      { type: 'command', invocation: { name: '/spaced' } },
    ])
  })

  it('ignores a duplicated optional tag (keeps the first match)', () => {
    const input =
      '<command-name>/foo</command-name>' +
      '<command-args>first</command-args>' +
      '<command-args>second</command-args>'
    const segments = parseCommandWrappers(input)
    expect(segments[0]).toEqual({
      type: 'command',
      invocation: { name: '/foo', args: 'first' },
    })
    expect(segments[1]).toEqual({
      type: 'text',
      text: '<command-args>second</command-args>',
    })
  })
})
