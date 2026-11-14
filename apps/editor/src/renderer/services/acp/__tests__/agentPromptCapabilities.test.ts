import { describe, expect, it } from 'vitest'
import type { IAcpAgentDescriptor } from '../acpAgentRegistry.js'
import { agentPromptCapabilities, supportsSystemPromptAppend } from '../agentPromptCapabilities.js'

function descriptor(overrides: Partial<IAcpAgentDescriptor> = {}): IAcpAgentDescriptor {
  return { id: 'agent', name: 'Agent', command: 'agent', args: [], ...overrides }
}

describe('supportsSystemPromptAppend', () => {
  it('is true for the bundled claude fork', () => {
    expect(supportsSystemPromptAppend(descriptor({ nodeEntry: 'claude' }))).toBe(true)
  })

  it('is false for the bundled codex fork (it ignores unknown _meta)', () => {
    expect(supportsSystemPromptAppend(descriptor({ nodeEntry: 'codex' }))).toBe(false)
  })

  it('is false for unknown agents and user overrides of a built-in id', () => {
    expect(supportsSystemPromptAppend(descriptor())).toBe(false)
    // A user entry may reuse the claude-code id but is an arbitrary command; it
    // has no nodeEntry and must not inherit the fork's wire contract.
    expect(supportsSystemPromptAppend(descriptor({ id: 'claude-code' }))).toBe(false)
  })

  it('exposes a capability table that can grow', () => {
    expect(agentPromptCapabilities(descriptor({ nodeEntry: 'claude' }))).toEqual({
      systemPromptAppend: true,
    })
    expect(agentPromptCapabilities(descriptor())).toEqual({ systemPromptAppend: false })
  })
})
