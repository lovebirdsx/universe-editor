/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  The candidate service must honour a context window the user declared in
 *  `aiSettings.json` → `models` on the subscription path too. Regression: a
 *  ChatGPT-login codex session only read windows off provider models, so the
 *  "context window unknown" warning pointed at a declaration it never read and
 *  kept firing after the user added one.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest'
import type { AiModelKnowledge, AiProviderEntry, IAiModelService } from '@universe-editor/platform'
import type { AgentActiveAuth } from '../../../../shared/ai/agentActiveAuth.js'
import type { IClaudeConfigService } from '../../../../shared/ipc/claudeConfigService.js'
import type { ICodexConfigService } from '../../../../shared/ipc/codexConfigService.js'
import { AcpModelCandidateService } from '../acpModelCandidateService.js'

interface HarnessOptions {
  readonly activeAuth: AgentActiveAuth
  readonly codexModel?: string
  readonly providers?: readonly AiProviderEntry[]
  readonly knowledge?: Readonly<Record<string, AiModelKnowledge>>
  readonly userKnowledge?: Readonly<Record<string, AiModelKnowledge>>
}

function harness(options: HarnessOptions): AcpModelCandidateService {
  const ai = {
    getProviders: vi.fn().mockResolvedValue(options.providers ?? []),
    getModelKnowledge: vi.fn().mockResolvedValue(options.knowledge ?? {}),
    getUserModelKnowledge: vi.fn().mockResolvedValue(options.userKnowledge ?? {}),
  } as unknown as IAiModelService
  const claude = {
    read: vi.fn().mockResolvedValue({}),
    resolveActiveAuth: vi.fn().mockResolvedValue(options.activeAuth),
  } as unknown as IClaudeConfigService
  const codex = {
    read: vi
      .fn()
      .mockResolvedValue(options.codexModel === undefined ? {} : { model: options.codexModel }),
    resolveActiveAuth: vi.fn().mockResolvedValue(options.activeAuth),
  } as unknown as ICodexConfigService
  return new AcpModelCandidateService(ai, claude, codex)
}

describe('AcpModelCandidateService — user-declared context windows', () => {
  it('carries the ChatGPT-login pick window from the user models layer', async () => {
    const service = harness({
      activeAuth: { kind: 'subscription' },
      codexModel: 'gpt-6.1-sol',
      userKnowledge: { 'gpt-6.1-sol': { maxInputTokens: 922000 } },
    })
    await expect(service.extraModelsForAgent('codex')).resolves.toEqual({
      pick: 'gpt-6.1-sol',
      candidates: [{ id: 'gpt-6.1-sol' }],
      declaredWindows: { 'gpt-6.1-sol': 922000 },
    })
  })

  it('carries no declared windows when the user configured none', async () => {
    const service = harness({
      activeAuth: { kind: 'subscription' },
      codexModel: 'gpt-6.1-sol',
    })
    await expect(service.extraModelsForAgent('codex')).resolves.toEqual({
      pick: 'gpt-6.1-sol',
      candidates: [{ id: 'gpt-6.1-sol' }],
      declaredWindows: {},
    })
  })

  it('keeps the provider-declared candidate window alongside the declaration', async () => {
    const service = harness({
      activeAuth: { kind: 'provider', providerId: 'gw' },
      codexModel: 'gw-model',
      providers: [
        {
          id: 'gw',
          baseUrl: 'https://gw.example.com',
          apiKey: 'ak-1',
          defaultProtocol: 'openai-responses',
          protocolMap: { 'openai-responses': ['gw-model'] },
        },
      ],
      knowledge: { 'gw-model': { maxInputTokens: 128000 } },
      userKnowledge: { 'gw-model': { maxInputTokens: 922000 } },
    })
    await expect(service.extraModelsForAgent('codex')).resolves.toEqual({
      pick: 'gw-model',
      candidates: [{ id: 'gw-model', contextWindow: 128000 }],
      declaredWindows: { 'gw-model': 922000 },
    })
  })
})
