/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/renderer/services/acp/acpSessionEditorInput.ts
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import { AcpSessionEditorInput } from '../acpSessionEditorInput.js'

describe('AcpSessionEditorInput', () => {
  it('serialize/deserialize round-trips sessionId and agentId', () => {
    const input = new AcpSessionEditorInput('sess-1', 'claude-code')
    const restored = AcpSessionEditorInput.deserialize(input.serialize())
    expect(restored?.sessionId).toBe('sess-1')
    expect(restored?.agentId).toBe('claude-code')
  })

  it('serialize omits agentId when not provided so payload stays minimal', () => {
    const input = new AcpSessionEditorInput('sess-2')
    expect(JSON.parse(input.serialize())).toEqual({ sessionId: 'sess-2' })
  })

  it('deserialize accepts legacy payloads without agentId', () => {
    const restored = AcpSessionEditorInput.deserialize(JSON.stringify({ sessionId: 'sess-3' }))
    expect(restored?.sessionId).toBe('sess-3')
    expect(restored?.agentId).toBeUndefined()
  })

  it('deserialize ignores malformed payloads', () => {
    expect(AcpSessionEditorInput.deserialize('not-json')).toBeNull()
    expect(AcpSessionEditorInput.deserialize(JSON.stringify({ sessionId: 42 }))).toBeNull()
    expect(AcpSessionEditorInput.deserialize(42 as unknown)).toBeNull()
  })

  it('deserialize discards agentId of wrong type while keeping sessionId', () => {
    const restored = AcpSessionEditorInput.deserialize(
      JSON.stringify({ sessionId: 'sess-4', agentId: 7 }),
    )
    expect(restored?.sessionId).toBe('sess-4')
    expect(restored?.agentId).toBeUndefined()
  })

  it('serialize/deserialize round-trips historyId so editor restart can auto-resume', () => {
    const input = new AcpSessionEditorInput('sess-5', 'claude-code', 'h7-xyz')
    const restored = AcpSessionEditorInput.deserialize(input.serialize())
    expect(restored?.sessionId).toBe('sess-5')
    expect(restored?.agentId).toBe('claude-code')
    expect(restored?.historyId).toBe('h7-xyz')
  })

  it('serialize omits historyId when not provided', () => {
    const input = new AcpSessionEditorInput('sess-6', 'claude-code')
    const parsed = JSON.parse(input.serialize()) as Record<string, unknown>
    expect(parsed['historyId']).toBeUndefined()
  })

  it('deserialize accepts legacy payloads without historyId', () => {
    const restored = AcpSessionEditorInput.deserialize(
      JSON.stringify({ sessionId: 'sess-7', agentId: 'fake' }),
    )
    expect(restored?.sessionId).toBe('sess-7')
    expect(restored?.historyId).toBeUndefined()
  })

  it('deserialize discards historyId of wrong type while keeping sessionId', () => {
    const restored = AcpSessionEditorInput.deserialize(
      JSON.stringify({ sessionId: 'sess-8', historyId: 9 }),
    )
    expect(restored?.sessionId).toBe('sess-8')
    expect(restored?.historyId).toBeUndefined()
  })
})
