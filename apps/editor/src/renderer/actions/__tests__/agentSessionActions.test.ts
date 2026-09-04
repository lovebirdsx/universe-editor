/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Agent session action tests. Currently guards the Choose Agent semantics:
 *  picking an agent only persists it as the default — creating a session is
 *  the job of the dedicated `+` button / `workbench.action.agent.newSession`.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest'
import {
  CommandsRegistry,
  InstantiationService,
  IQuickInputService,
  ServiceCollection,
  constObservable,
  registerAction2,
} from '@universe-editor/platform'
import { SelectAgentAction } from '../agentSessionActions.js'
import { IAcpAgentRegistry, type IAcpAgentDescriptor } from '../../services/acp/acpAgentRegistry.js'

const AGENTS: readonly IAcpAgentDescriptor[] = [
  { id: 'claude-code', name: 'Claude Code', command: 'claude', args: [] },
  { id: 'codex', name: 'Codex', command: 'codex', args: [] },
]

function makeRegistry() {
  return {
    _serviceBrand: undefined,
    list: () => AGENTS,
    defaultAgentId: () => 'claude-code',
    defaultAgentIdObs: constObservable('claude-code'),
    setDefaultAgentId: vi.fn(),
    health: vi.fn().mockResolvedValue({ available: true }),
  }
}

async function run(
  registry: ReturnType<typeof makeRegistry>,
  picked: { id: string; label: string } | undefined,
): Promise<void> {
  const dispose = registerAction2(SelectAgentAction)
  try {
    const services = new ServiceCollection()
    services.set(IAcpAgentRegistry, registry as never)
    services.set(IQuickInputService, {
      _serviceBrand: undefined,
      pick: vi.fn().mockResolvedValue(picked),
    } as never)
    const inst = new InstantiationService(services)
    await inst.invokeFunction(async (accessor) => {
      await Promise.resolve(CommandsRegistry.getCommand(SelectAgentAction.ID)!.handler(accessor))
    })
  } finally {
    dispose.dispose()
  }
}

describe('SelectAgentAction', () => {
  it('persists the picked agent as the default', async () => {
    const registry = makeRegistry()
    await run(registry, { id: 'codex', label: 'Codex' })
    expect(registry.setDefaultAgentId).toHaveBeenCalledWith('codex')
  })

  it('does nothing when the pick is cancelled', async () => {
    const registry = makeRegistry()
    await run(registry, undefined)
    expect(registry.setDefaultAgentId).not.toHaveBeenCalled()
  })

  it('declares no dependency on the session service (selection only)', () => {
    // Regression guard: the action previously created a session right after the
    // pick; its accessor surface must stay free of IAcpSessionService so the
    // "only switch the default agent" contract can't silently regress.
    const src = SelectAgentAction.prototype.run.toString()
    expect(src).not.toContain('IAcpSessionService')
    expect(src).not.toContain('createSession')
  })
})
