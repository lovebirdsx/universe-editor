import type { MobileSessionRef, MobileToolCallDetail } from '@universe-editor/mobile-protocol'
import { COMMAND_TIMEOUT_MS, CommandError, type CommandClient } from './commandClient.js'

export const TOOL_CALL_DETAIL_TIMEOUT_MS = COMMAND_TIMEOUT_MS.getToolCallDetail

/** Kept for callers that only deal with detail requests. */
export { CommandError as ToolCallDetailError }

/**
 * Caching front for `getToolCallDetail` on top of the shared command pipeline.
 * The cache is keyed by tool-call id and dropped whenever the call changes.
 */
export class ToolCallDetailClient {
  private readonly _commands: CommandClient
  private readonly _cache = new Map<string, MobileToolCallDetail>()

  constructor(commands: CommandClient) {
    this._commands = commands
  }

  async request(ref: MobileSessionRef, toolCallId: string): Promise<MobileToolCallDetail> {
    const cached = this._cache.get(toolCallId)
    if (cached !== undefined) return cached
    const detail = await this._commands.request<MobileToolCallDetail>(
      'getToolCallDetail',
      { ref, toolCallId },
      { validateResult: isToolCallDetail },
    )
    this._cache.set(toolCallId, detail)
    return detail
  }

  invalidate(toolCallId: string): void {
    this._cache.delete(toolCallId)
  }

  clear(): void {
    this._cache.clear()
  }
}

function isToolCallDetail(value: unknown): value is MobileToolCallDetail {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return (
    typeof record['id'] === 'string' &&
    typeof record['title'] === 'string' &&
    typeof record['kind'] === 'string' &&
    typeof record['status'] === 'string' &&
    typeof record['text'] === 'string' &&
    Array.isArray(record['diffs'])
  )
}

export { CommandError }
