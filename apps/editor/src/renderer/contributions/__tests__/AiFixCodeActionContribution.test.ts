import { describe, expect, it, vi } from 'vitest'
import { observableValue, type ILogger } from '@universe-editor/platform'
import {
  AI_FIX_COMMAND_ID,
  createAiFixCodeActionProvider,
  executeAiFix,
  type AiFixRunServices,
} from '../AiFixCodeActionContribution.js'
import type { AiFixMarker, AiFixModel, AiFixProblemArg } from '../../services/acp/aiFixPrompt.js'
import type { IAcpSession } from '../../services/acp/session/acpSessionModel.js'
import type { RevealServices } from '../../actions/_agentChatTarget.js'
import type { SessionConfigOption } from '@agentclientprotocol/sdk'

const MARKER: AiFixMarker = {
  message: 'Type mismatch',
  severity: 8,
  startLineNumber: 2,
  startColumn: 3,
  endLineNumber: 2,
  endColumn: 9,
}

function fakeModel(): AiFixModel {
  const lines = ['const a = 1', 'const b: number = "x"', 'export { a, b }']
  return {
    uri: { toString: () => 'file:///ws/src/a.ts' },
    getLineCount: () => lines.length,
    getLineMaxColumn: (line) => (lines[line - 1]?.length ?? 0) + 1,
    getValueInRange: (range) =>
      lines.slice(range.startLineNumber - 1, range.endLineNumber).join('\n'),
    getLanguageId: () => 'typescript',
  }
}

describe('createAiFixCodeActionProvider', () => {
  const relPathFor = () => 'src/a.ts'

  it('returns an empty list when the hover has no markers', () => {
    const provider = createAiFixCodeActionProvider(relPathFor)
    const result = provider.provideCodeActions(fakeModel(), undefined, { markers: [] })
    expect(result.actions).toEqual([])
  })

  it('returns a single isAI quickfix carrying the snapshotted arg', () => {
    const provider = createAiFixCodeActionProvider(relPathFor)
    const result = provider.provideCodeActions(fakeModel(), undefined, { markers: [MARKER] })

    expect(result.actions).toHaveLength(1)
    const action = result.actions[0]!
    expect(action.kind).toBe('quickfix')
    expect(action.isAI).toBe(true)
    expect(action.title).toBe('Fix with AI')
    expect(action.diagnostics).toEqual([MARKER])
    expect(action.command.id).toBe(AI_FIX_COMMAND_ID)

    const arg = action.command.arguments[0]
    expect(arg.resource).toBe('file:///ws/src/a.ts')
    expect(arg.problems).toHaveLength(1)
    expect(arg.problems[0]).toMatchObject({ message: 'Type mismatch', startLineNumber: 2 })
    expect(arg.contexts).toHaveLength(1)
    expect(arg.contexts[0]).toMatchObject({
      relPath: 'src/a.ts',
      startLine: 1,
      endLine: 3,
    })
    expect(arg.contexts[0]!.text).toContain('const b: number = "x"')
  })
})

describe('executeAiFix', () => {
  function stubArg(): AiFixProblemArg {
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
      problems: [
        {
          message: 'Type mismatch',
          severity: 8,
          startLineNumber: 2,
          startColumn: 3,
          endLineNumber: 2,
          endColumn: 9,
        },
      ],
    }
  }

  function stubHarness(opts: {
    settings?: Record<string, string>
    agents?: ReadonlyArray<{ id: string; name: string }>
    cachedBag?: readonly SessionConfigOption[]
  }) {
    const sendPrompt = vi.fn().mockResolvedValue(undefined)
    const createSession = vi.fn()
    const focusSessionInput = vi.fn()
    const openViewContainer = vi.fn().mockResolvedValue(undefined)
    const session = { id: 'sess-new', agentId: 'codex', sendPrompt } as unknown as IAcpSession
    createSession.mockResolvedValue(session)
    const agents = opts.agents ?? [
      { id: 'codex', name: 'Codex' },
      { id: 'claude-code', name: 'Claude Code' },
    ]
    const settingsMap: Record<string, string> = {
      'acp.aiFix.agentId': 'codex',
      'acp.aiFix.model': '',
      'acp.aiFix.thoughtLevel': 'low',
      'acp.aiFix.mode': '',
      ...opts.settings,
    }
    const reveal = {
      sessions: {
        activeSession: observableValue<IAcpSession | undefined>('t.active', undefined),
        createSession,
        getById: () => undefined,
      },
      registry: {
        list: () => agents,
        defaultAgentId: () => 'claude-code',
      },
      location: { location: observableValue<'editor' | 'sidebar'>('t.loc', 'sidebar') },
      widgets: { focusSessionInput },
      groups: { groups: [], activeGroup: {}, activeGroupForOpen: {}, activateGroup: vi.fn() },
      inst: { createInstance: vi.fn() },
      layout: { getVisible: () => true, toggleVisible: vi.fn() },
      views: { openViewContainer },
    } as unknown as RevealServices
    const run: AiFixRunServices = {
      config: {
        get: (key: string) => settingsMap[key],
      } as unknown as AiFixRunServices['config'],
      configOptionsCache: {
        get: () => opts.cachedBag ?? [],
      } as unknown as AiFixRunServices['configOptionsCache'],
    }
    const logger = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as ILogger
    return { reveal, run, logger, sendPrompt, createSession, focusSessionInput, openViewContainer }
  }

  it('always creates a dedicated session with title / aiFix / overrides', async () => {
    const s = stubHarness({
      settings: {
        'acp.aiFix.agentId': 'codex',
        'acp.aiFix.model': 'gpt-5-codex',
        'acp.aiFix.thoughtLevel': 'low',
        'acp.aiFix.mode': 'auto',
      },
      cachedBag: [
        {
          id: 'model',
          name: 'Model',
          category: 'model',
          type: 'select',
          currentValue: 'gpt-5',
          options: [
            { value: 'gpt-5', name: 'GPT-5' },
            { value: 'gpt-5-codex', name: 'GPT-5 Codex' },
          ],
        },
        {
          id: 'reasoning_effort',
          name: 'Effort',
          category: 'thought_level',
          type: 'select',
          currentValue: 'medium',
          options: [
            { value: 'low', name: 'Low' },
            { value: 'medium', name: 'Medium' },
          ],
        },
        {
          id: 'mode',
          name: 'Mode',
          category: 'mode',
          type: 'select',
          currentValue: 'read-only',
          options: [
            { value: 'read-only', name: 'Read Only' },
            { value: 'auto', name: 'Auto' },
          ],
        },
      ],
    })
    await executeAiFix(s.reveal, s.run, stubArg(), s.logger)

    expect(s.createSession).toHaveBeenCalledTimes(1)
    const [agentId, options] = s.createSession.mock.calls[0]!
    expect(agentId).toBe('codex')
    expect(options).toEqual({
      title: 'AI Fix: src/a.ts',
      aiFix: true,
      configDesiredOverrides: {
        model: 'gpt-5-codex',
        reasoning_effort: 'low',
        mode: 'auto',
      },
    })
    const [text, refs, contexts, images] = s.sendPrompt.mock.calls[0]!
    expect(text).toContain('src/a.ts')
    expect(text).toContain('- Error at 2:3: Type mismatch')
    expect(refs).toEqual([])
    expect(contexts).toHaveLength(1)
    expect(images).toEqual([])
    expect(s.openViewContainer).toHaveBeenCalledWith('workbench.view.agents')
    expect(s.focusSessionInput).toHaveBeenCalledWith('sess-new')
  })

  it('falls back to the default agent when the configured agentId is unknown', async () => {
    const s = stubHarness({
      settings: {
        'acp.aiFix.agentId': 'ghost',
        // Keep every other setting empty so the cold-cache warning stays out
        // of this test's assertions.
        'acp.aiFix.thoughtLevel': '',
      },
    })
    await executeAiFix(s.reveal, s.run, stubArg(), s.logger)

    expect(s.createSession).toHaveBeenCalledTimes(1)
    expect(s.createSession.mock.calls[0]![0]).toBe('claude-code')
    expect(s.logger.warn).toHaveBeenCalledTimes(1)
  })

  it('creates with the factory defaults when nothing is configured', async () => {
    const s = stubHarness({ settings: {} })
    await executeAiFix(s.reveal, s.run, stubArg(), s.logger)

    const [agentId, options] = s.createSession.mock.calls[0]!
    expect(agentId).toBe('codex')
    // Empty cache → no overrides, and the untouched mode setting stays silent.
    expect(options).toMatchObject({ aiFix: true, configDesiredOverrides: {} })
    // The thought-level default 'low' has no cached bag to resolve against — a
    // single cold-cache warning is expected.
    expect(s.logger.warn).toHaveBeenCalledTimes(1)
  })

  it('logs and swallows dispatch failures', async () => {
    const s = stubHarness({})
    s.sendPrompt.mockRejectedValue(new Error('boom'))
    await expect(executeAiFix(s.reveal, s.run, stubArg(), s.logger)).resolves.toBeUndefined()
    expect(s.logger.error).toHaveBeenCalledTimes(1)
  })
})
