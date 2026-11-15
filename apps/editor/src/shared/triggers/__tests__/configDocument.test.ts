/*---------------------------------------------------------------------------------------------
 *  Tests for the JSONC document helpers: locating a trigger, minimal edits that
 *  preserve comments, appending triggers, offset → line mapping and section
 *  jumps, plus the shared parse result used by the form.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import {
  appendTrigger,
  applyTriggerEdits,
  detectFormattingOptions,
  locateTrigger,
  offsetToLine,
  parseTriggerDocument,
  triggerSectionLine,
} from '../configDocument.js'
import type { TriggerConfig } from '../types.js'

const CONFIG_TEXT = `// Header comment: agent triggers for this workspace.
{
  "version": 1,
  "triggers": [
    // Between-trigger comment.
    {
      "id": "alpha",
      "name": "Alpha", // keep this inline comment
      "enabled": false,
      "source": { "type": "manual" },
      "session": {
        "agent": "claude-code",
        "prompt": "Do the thing",
        "budget": { "maxCostUsd": 1, "timeoutMin": 30, "approvalTimeoutMin": 1440 }
      }
    },
    {
      "id": "beta",
      "name": "Beta",
      "source": { "type": "event", "event": "swarm.reviewNeedsAction" },
      "session": { "skill": "swarm-triage" }
    }
  ]
}
`

function trigger(overrides: Partial<TriggerConfig> = {}): TriggerConfig {
  return {
    id: 'gamma',
    name: 'Gamma',
    enabled: false,
    showSession: false,
    source: { type: 'manual' },
    session: {
      prompt: 'Run gamma',
      budget: { maxCostUsd: 1, timeoutMin: 30, approvalTimeoutMin: 1440 },
    },
    concurrency: 1,
    overflow: 'queue',
    ...overrides,
  }
}

describe('locateTrigger', () => {
  it('returns the index and JSON path of the matching trigger', () => {
    expect(locateTrigger(CONFIG_TEXT, 'alpha')).toEqual({ index: 0, path: ['triggers', 0] })
    expect(locateTrigger(CONFIG_TEXT, 'beta')).toEqual({ index: 1, path: ['triggers', 1] })
  })

  it('returns undefined for an unknown id or missing array', () => {
    expect(locateTrigger(CONFIG_TEXT, 'nope')).toBeUndefined()
    expect(locateTrigger('{ "version": 1 }', 'alpha')).toBeUndefined()
    expect(locateTrigger('[]', 'alpha')).toBeUndefined()
  })
})

describe('applyTriggerEdits', () => {
  it('changes only the targeted field and keeps every comment', () => {
    const next = applyTriggerEdits(CONFIG_TEXT, [
      { path: ['triggers', 0, 'name'], value: 'Alpha renamed' },
    ])

    expect(next).toContain('// Header comment: agent triggers for this workspace.')
    expect(next).toContain('// Between-trigger comment.')
    expect(next).toContain('"name": "Alpha renamed", // keep this inline comment')
    expect(next).toContain('"name": "Beta"')
    expect(locateTrigger(next, 'beta')?.index).toBe(1)
  })

  it('leaves the document untouched when the value is unchanged', () => {
    const next = applyTriggerEdits(CONFIG_TEXT, [{ path: ['triggers', 0, 'name'], value: 'Alpha' }])
    expect(next).toBe(CONFIG_TEXT)
  })

  it('removes a property when the value is undefined', () => {
    const next = applyTriggerEdits(CONFIG_TEXT, [
      { path: ['triggers', 0, 'session', 'agent'], value: undefined },
    ])
    expect(next).not.toContain('"agent"')
    expect(parseTriggerDocument(next).kind).toBe('ok')
  })

  it('replaces nested arrays and keeps surrounding comments', () => {
    const next = applyTriggerEdits(CONFIG_TEXT, [
      { path: ['triggers', 0, 'session', 'mcpServers'], value: ['swarm'] },
    ])
    expect(next).toContain('"swarm"')
    expect(next).toContain('// Between-trigger comment.')
  })
})

describe('appendTrigger', () => {
  it('appends to the existing array without disturbing comments', () => {
    const next = appendTrigger(CONFIG_TEXT, trigger())
    expect(next).toContain('// Header comment: agent triggers for this workspace.')
    expect(locateTrigger(next, 'gamma')).toEqual({ index: 2, path: ['triggers', 2] })
    expect(parseTriggerDocument(next).kind).toBe('ok')
  })

  it('creates the triggers array when it is missing', () => {
    const next = appendTrigger('{ "version": 1 }\n', trigger())
    expect(locateTrigger(next, 'gamma')?.index).toBe(0)
    expect(parseTriggerDocument(next).kind).toBe('ok')
  })

  it('writes a fresh document into an empty file', () => {
    const next = appendTrigger('', trigger())
    expect(next).toContain('"gamma"')
    expect(parseTriggerDocument(next).kind).toBe('ok')
  })

  it('rejects a non-object root rather than overwriting it', () => {
    expect(() => appendTrigger('[]', trigger())).toThrow()
    expect(() => appendTrigger('// only a comment\n', trigger())).toThrow()
  })
})

describe('offsetToLine', () => {
  it('maps offsets to 1-based lines and clamps out-of-range values', () => {
    const text = 'a\nbb\n\nccc'
    expect(offsetToLine(text, 0)).toBe(1)
    expect(offsetToLine(text, 2)).toBe(2)
    expect(offsetToLine(text, text.length)).toBe(4)
    expect(offsetToLine(text, 999)).toBe(4)
    expect(offsetToLine(text, -1)).toBe(1)
  })
})

describe('triggerSectionLine', () => {
  it('finds the line of each section', () => {
    expect(triggerSectionLine(CONFIG_TEXT, 'alpha', 'trigger')).toBe(6)
    expect(triggerSectionLine(CONFIG_TEXT, 'alpha', 'source')).toBe(10)
    expect(triggerSectionLine(CONFIG_TEXT, 'alpha', 'session')).toBe(11)
    expect(triggerSectionLine(CONFIG_TEXT, 'alpha', 'budget')).toBe(14)
  })

  it('returns undefined for a missing section or unknown trigger', () => {
    expect(triggerSectionLine(CONFIG_TEXT, 'beta', 'budget')).toBeUndefined()
    expect(triggerSectionLine(CONFIG_TEXT, 'nope', 'session')).toBeUndefined()
  })
})

describe('parseTriggerDocument', () => {
  it('accepts a valid document and reports invalid roots', () => {
    expect(parseTriggerDocument(CONFIG_TEXT).kind).toBe('ok')
    expect(parseTriggerDocument('[]').kind).toBe('invalid')
    expect(parseTriggerDocument('{ "triggers": {} }').kind).toBe('invalid')
  })

  it('treats an empty file as an empty config', () => {
    const parsed = parseTriggerDocument('')
    expect(parsed.kind).toBe('ok')
  })
})

describe('detectFormattingOptions', () => {
  it('follows the existing indentation and EOL style', () => {
    expect(detectFormattingOptions('{\r\n    "a": 1\r\n}\r\n')).toMatchObject({
      insertSpaces: true,
      tabSize: 4,
      eol: '\r\n',
    })
    expect(detectFormattingOptions('{\n\t"a": 1\n}\n')).toMatchObject({
      insertSpaces: false,
      tabSize: 1,
      eol: '\n',
    })
  })
})
