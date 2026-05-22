/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/renderer/services/acp/acpProtocol.ts — focuses on
 *  the Stage 7+ parsers (configOption / availableCommand / session/new result).
 *  These parsers reject malformed payloads, so the negative paths matter as
 *  much as the happy ones.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import {
  parseAvailableCommand,
  parseInitializeResult,
  parseLoadSessionResult,
  parseNewSessionResult,
  parseSessionModeState,
  parseSessionUpdateParams,
  parseSetConfigOptionResult,
  parseTerminalCreateParams,
  parseTerminalIdRequest,
} from '../acpProtocol.js'

describe('acpProtocol — parseNewSessionResult', () => {
  it('parses a bare {sessionId} payload', () => {
    const r = parseNewSessionResult({ sessionId: 'abc' })
    expect(r).toEqual({ sessionId: 'abc' })
  })

  it('parses sessionId + legacy modes block', () => {
    const r = parseNewSessionResult({
      sessionId: 'abc',
      modes: {
        currentModeId: 'plan',
        availableModes: [
          { id: 'plan', name: 'Plan' },
          { id: 'act', name: 'Act', description: 'Make changes' },
        ],
      },
    })
    expect(r?.sessionId).toBe('abc')
    expect(r?.modes?.currentModeId).toBe('plan')
    expect(r?.modes?.availableModes).toHaveLength(2)
    expect(r?.modes?.availableModes[1]).toEqual({
      id: 'act',
      name: 'Act',
      description: 'Make changes',
    })
  })

  it('parses sessionId + configOptions block', () => {
    const r = parseNewSessionResult({
      sessionId: 'abc',
      configOptions: [
        {
          id: 'model',
          name: 'Model',
          category: 'model',
          type: 'select',
          currentValue: 'sonnet',
          options: [
            { value: 'sonnet', name: 'Sonnet 4.6' },
            { value: 'opus', name: 'Opus 4.7', description: 'Strongest reasoning' },
          ],
        },
      ],
    })
    expect(r?.configOptions).toHaveLength(1)
    const opt = r?.configOptions?.[0]
    expect(opt?.category).toBe('model')
    expect(opt?.currentValue).toBe('sonnet')
    expect(opt?.options[1]?.description).toBe('Strongest reasoning')
  })

  it('rejects malformed input', () => {
    expect(parseNewSessionResult(null)).toBeNull()
    expect(parseNewSessionResult({})).toBeNull()
    expect(parseNewSessionResult({ sessionId: 1 })).toBeNull()
  })

  it('drops configOptions if any entry is malformed (atomic parse)', () => {
    // currentValue is missing on the second entry → parseConfigOptionsArray
    // returns null and the top-level result silently omits the field.
    const r = parseNewSessionResult({
      sessionId: 'abc',
      configOptions: [
        {
          id: 'model',
          name: 'Model',
          type: 'select',
          currentValue: 'a',
          options: [{ value: 'a', name: 'A' }],
        },
        { id: 'broken', name: 'Broken', type: 'select', options: [] },
      ],
    })
    expect(r?.sessionId).toBe('abc')
    expect(r?.configOptions).toBeUndefined()
  })
})

describe('acpProtocol — parseSessionModeState', () => {
  it('parses currentModeId + availableModes', () => {
    const s = parseSessionModeState({
      currentModeId: 'a',
      availableModes: [{ id: 'a', name: 'A' }],
    })
    expect(s?.currentModeId).toBe('a')
    expect(s?.availableModes).toHaveLength(1)
  })

  it('rejects when currentModeId is missing', () => {
    expect(parseSessionModeState({ availableModes: [] })).toBeNull()
  })
})

describe('acpProtocol — parseSetConfigOptionResult', () => {
  it('parses an empty array', () => {
    expect(parseSetConfigOptionResult({ configOptions: [] })).toEqual({ configOptions: [] })
  })

  it('parses a populated array', () => {
    const r = parseSetConfigOptionResult({
      configOptions: [
        {
          id: 'thought_level',
          name: 'Thinking',
          category: 'thought_level',
          type: 'select',
          currentValue: 'high',
          options: [
            { value: 'low', name: 'Low' },
            { value: 'high', name: 'High' },
          ],
        },
      ],
    })
    expect(r?.configOptions[0]?.currentValue).toBe('high')
  })

  it('rejects missing configOptions field', () => {
    expect(parseSetConfigOptionResult({})).toBeNull()
    expect(parseSetConfigOptionResult(null)).toBeNull()
  })
})

describe('acpProtocol — parseAvailableCommand', () => {
  it('parses name + description', () => {
    expect(parseAvailableCommand({ name: '/diff', description: 'show diff' })).toEqual({
      name: '/diff',
      description: 'show diff',
    })
  })

  it('parses input hint when present', () => {
    expect(
      parseAvailableCommand({
        name: '/file',
        description: 'open file',
        input: { hint: 'path' },
      }),
    ).toEqual({ name: '/file', description: 'open file', input: { hint: 'path' } })
  })

  it('rejects malformed input.hint', () => {
    expect(parseAvailableCommand({ name: '/x', description: 'd', input: {} })).toBeNull()
    expect(parseAvailableCommand({ name: '/x', description: 'd', input: { hint: 1 } })).toBeNull()
  })
})

describe('acpProtocol — parseSessionUpdateParams (Stage 7 variants)', () => {
  it('parses available_commands_update', () => {
    const r = parseSessionUpdateParams({
      sessionId: 'agent-1',
      update: {
        sessionUpdate: 'available_commands_update',
        availableCommands: [{ name: '/help', description: 'help' }],
      },
    })
    expect(r?.update.sessionUpdate).toBe('available_commands_update')
    if (r?.update.sessionUpdate === 'available_commands_update') {
      expect(r.update.availableCommands).toHaveLength(1)
    }
  })

  it('parses current_mode_update', () => {
    const r = parseSessionUpdateParams({
      sessionId: 'agent-1',
      update: { sessionUpdate: 'current_mode_update', currentModeId: 'plan' },
    })
    expect(r?.update.sessionUpdate).toBe('current_mode_update')
    if (r?.update.sessionUpdate === 'current_mode_update') {
      expect(r.update.currentModeId).toBe('plan')
    }
  })

  it('parses config_option_update', () => {
    const r = parseSessionUpdateParams({
      sessionId: 'agent-1',
      update: {
        sessionUpdate: 'config_option_update',
        configOptions: [
          {
            id: 'model',
            name: 'Model',
            type: 'select',
            currentValue: 'opus',
            options: [
              { value: 'opus', name: 'Opus' },
              { value: 'sonnet', name: 'Sonnet' },
            ],
          },
        ],
      },
    })
    expect(r?.update.sessionUpdate).toBe('config_option_update')
    if (r?.update.sessionUpdate === 'config_option_update') {
      expect(r.update.configOptions[0]?.currentValue).toBe('opus')
    }
  })

  it('rejects an unknown sessionUpdate kind', () => {
    expect(
      parseSessionUpdateParams({
        sessionId: 'x',
        update: { sessionUpdate: 'totally_bogus' },
      }),
    ).toBeNull()
  })
})

describe('acpProtocol — parseTerminalCreateParams', () => {
  it('parses sessionId + command alone', () => {
    expect(parseTerminalCreateParams({ sessionId: 's1', command: 'ls' })).toEqual({
      sessionId: 's1',
      command: 'ls',
    })
  })

  it('parses args, env, cwd, outputByteLimit together', () => {
    const r = parseTerminalCreateParams({
      sessionId: 's1',
      command: 'rg',
      args: ['--json', 'pattern'],
      env: [
        { name: 'FOO', value: 'bar' },
        { name: 'BAZ', value: 'qux' },
      ],
      cwd: '/abs/workspace',
      outputByteLimit: 4096,
    })
    expect(r).toEqual({
      sessionId: 's1',
      command: 'rg',
      args: ['--json', 'pattern'],
      env: [
        { name: 'FOO', value: 'bar' },
        { name: 'BAZ', value: 'qux' },
      ],
      cwd: '/abs/workspace',
      outputByteLimit: 4096,
    })
  })

  it('rejects when sessionId is missing', () => {
    expect(parseTerminalCreateParams({ command: 'ls' })).toBeNull()
  })

  it('rejects when command is missing or not a string', () => {
    expect(parseTerminalCreateParams({ sessionId: 's1' })).toBeNull()
    expect(parseTerminalCreateParams({ sessionId: 's1', command: 42 })).toBeNull()
  })

  it('rejects malformed args (non-string entries)', () => {
    expect(
      parseTerminalCreateParams({ sessionId: 's1', command: 'ls', args: ['ok', 1] }),
    ).toBeNull()
    expect(
      parseTerminalCreateParams({ sessionId: 's1', command: 'ls', args: 'not-an-array' }),
    ).toBeNull()
  })

  it('rejects malformed env entries', () => {
    expect(
      parseTerminalCreateParams({
        sessionId: 's1',
        command: 'ls',
        env: [{ name: 'FOO' }],
      }),
    ).toBeNull()
    expect(
      parseTerminalCreateParams({
        sessionId: 's1',
        command: 'ls',
        env: [{ name: 1, value: 'bar' }],
      }),
    ).toBeNull()
    expect(parseTerminalCreateParams({ sessionId: 's1', command: 'ls', env: 'nope' })).toBeNull()
  })

  it('rejects malformed cwd / outputByteLimit', () => {
    expect(parseTerminalCreateParams({ sessionId: 's1', command: 'ls', cwd: 42 })).toBeNull()
    expect(
      parseTerminalCreateParams({ sessionId: 's1', command: 'ls', outputByteLimit: '4096' }),
    ).toBeNull()
  })

  it('rejects non-object input', () => {
    expect(parseTerminalCreateParams(null)).toBeNull()
    expect(parseTerminalCreateParams('hi')).toBeNull()
  })
})

describe('acpProtocol — parseTerminalIdRequest', () => {
  it('parses sessionId + terminalId', () => {
    expect(parseTerminalIdRequest({ sessionId: 's1', terminalId: 't1' })).toEqual({
      sessionId: 's1',
      terminalId: 't1',
    })
  })

  it('rejects when either field is missing or non-string', () => {
    expect(parseTerminalIdRequest({ sessionId: 's1' })).toBeNull()
    expect(parseTerminalIdRequest({ terminalId: 't1' })).toBeNull()
    expect(parseTerminalIdRequest({ sessionId: 's1', terminalId: 42 })).toBeNull()
    expect(parseTerminalIdRequest({ sessionId: 1, terminalId: 't1' })).toBeNull()
  })

  it('rejects non-object input', () => {
    expect(parseTerminalIdRequest(null)).toBeNull()
    expect(parseTerminalIdRequest([])).toBeNull()
  })
})

describe('acpProtocol — parseInitializeResult', () => {
  it('parses a bare {protocolVersion} payload', () => {
    expect(parseInitializeResult({ protocolVersion: 1 })).toEqual({ protocolVersion: 1 })
  })

  it('parses agentCapabilities with loadSession=true', () => {
    const r = parseInitializeResult({
      protocolVersion: 1,
      agentCapabilities: { loadSession: true },
    })
    expect(r?.agentCapabilities?.loadSession).toBe(true)
  })

  it('parses agentCapabilities with loadSession=false', () => {
    const r = parseInitializeResult({
      protocolVersion: 1,
      agentCapabilities: { loadSession: false },
    })
    expect(r?.agentCapabilities?.loadSession).toBe(false)
  })

  it('parses agentCapabilities with promptCapabilities passthrough', () => {
    const r = parseInitializeResult({
      protocolVersion: 1,
      agentCapabilities: { promptCapabilities: { vision: true } },
    })
    expect(r?.agentCapabilities?.promptCapabilities).toEqual({ vision: true })
  })

  it('rejects malformed input', () => {
    expect(parseInitializeResult(null)).toBeNull()
    expect(parseInitializeResult({})).toBeNull()
    expect(parseInitializeResult({ protocolVersion: '1' })).toBeNull()
    expect(parseInitializeResult({ protocolVersion: 1, agentCapabilities: 'bad' })).toBeNull()
    expect(
      parseInitializeResult({ protocolVersion: 1, agentCapabilities: { loadSession: 'yes' } }),
    ).toBeNull()
  })
})

describe('acpProtocol — parseLoadSessionResult', () => {
  it('treats null / undefined as empty bag (agents legitimately return null)', () => {
    expect(parseLoadSessionResult(null)).toEqual({})
    expect(parseLoadSessionResult(undefined)).toEqual({})
  })

  it('parses an empty object as empty bag', () => {
    expect(parseLoadSessionResult({})).toEqual({})
  })

  it('parses modes + configOptions when present', () => {
    const r = parseLoadSessionResult({
      modes: { currentModeId: 'a', availableModes: [{ id: 'a', name: 'A' }] },
      configOptions: [
        {
          id: 'model',
          name: 'Model',
          type: 'select',
          currentValue: 'opus',
          options: [{ value: 'opus', name: 'Opus' }],
        },
      ],
    })
    expect(r?.modes?.currentModeId).toBe('a')
    expect(r?.configOptions).toHaveLength(1)
  })

  it('rejects non-object scalar input', () => {
    expect(parseLoadSessionResult('nope')).toBeNull()
    expect(parseLoadSessionResult(42)).toBeNull()
  })
})
