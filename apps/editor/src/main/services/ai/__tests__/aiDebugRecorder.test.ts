/*---------------------------------------------------------------------------------------------
 *  Tests for AiDebugRecorder — record lifecycle (begin/recordChunk/finish),
 *  status classification, summary projection, image placeholder, ring-buffer cap,
 *  enable flag, and the structured JSONL line (well-formed + no API key).
 *--------------------------------------------------------------------------------------------*/

import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  AiMessageRole,
  type AiMessage,
  type AiRequestOptions,
  type SerializedError,
} from '@universe-editor/platform'
import { AiDebugRecorder } from '../aiDebugRecorder.js'
import type { LogMainService } from '../../log/logMainService.js'

function makeRecorder(): { recorder: AiDebugRecorder; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'ai-debug-test-'))
  const logMain = { getSessionDir: () => dir } as unknown as LogMainService
  return { recorder: new AiDebugRecorder(logMain), dir }
}

function userMessage(text: string): AiMessage {
  return { role: AiMessageRole.User, content: [{ type: 'text', value: text }] }
}

const opts = (over?: Partial<AiRequestOptions>): AiRequestOptions => ({
  modelId: 'openai/default/gpt-4o',
  ...over,
})

// Wait for the fire-and-forget JSONL append to land (file present AND a full
// line flushed — existsSync alone can race ahead of the write).
async function waitForFile(path: string): Promise<void> {
  for (let i = 0; i < 50; i++) {
    if (existsSync(path) && readFileSync(path, 'utf8').includes('\n')) return
    await new Promise((r) => setTimeout(r, 10))
  }
}

describe('AiDebugRecorder', () => {
  let created: AiDebugRecorder[] = []
  const track = (r: AiDebugRecorder): AiDebugRecorder => {
    created.push(r)
    return r
  }
  afterEach(() => {
    for (const r of created) r.dispose()
    created = []
  })

  it('records a successful request with usage and produces a summary', () => {
    const { recorder } = makeRecorder()
    track(recorder)
    recorder.begin('r1', [userMessage('hello')], opts({ purpose: 'inline-completion' }))
    recorder.recordChunk('r1', { type: 'text', value: 'Hel' })
    recorder.recordChunk('r1', { type: 'text', value: 'lo' })
    recorder.recordChunk('r1', { type: 'usage', inputTokens: 12, outputTokens: 48 })
    recorder.finish('r1')

    const list = recorder.listRecords()
    expect(list).toHaveLength(1)
    expect(list[0]!.purpose).toBe('inline-completion')
    expect(list[0]!.status).toBe('ok')
    expect(list[0]!.responsePreview).toBe('Hello')
    expect(list[0]!.tokens).toEqual({ inputTokens: 12, outputTokens: 48 })

    const full = recorder.getRecord(list[0]!.id)
    expect(full?.responseText).toBe('Hello')
    expect(full?.messages[0]).toEqual({ role: AiMessageRole.User, text: 'hello' })
    expect(full?.modelId).toBe('openai/default/gpt-4o')
    expect(full?.vendor).toBe('openai')
    expect(full?.groupName).toBe('default')
  })

  it('classifies an error as error status', () => {
    const { recorder } = makeRecorder()
    track(recorder)
    recorder.begin('r1', [userMessage('x')], opts())
    const err: SerializedError = { $isError: true, name: 'Error', message: 'boom' }
    recorder.finish('r1', err)
    expect(recorder.listRecords()[0]!.status).toBe('error')
    expect(recorder.getRecord(recorder.listRecords()[0]!.id)?.error?.message).toBe('boom')
  })

  it('classifies a canceled error as canceled status', () => {
    const { recorder } = makeRecorder()
    track(recorder)
    recorder.begin('r1', [userMessage('x')], opts())
    recorder.finish('r1', { $isError: true, name: 'Canceled', message: 'Canceled' })
    expect(recorder.listRecords()[0]!.status).toBe('canceled')
  })

  it('renders image parts as a placeholder, not raw bytes', () => {
    const { recorder } = makeRecorder()
    track(recorder)
    const msg: AiMessage = {
      role: AiMessageRole.User,
      content: [{ type: 'image', mimeType: 'image/png', data: new Uint8Array([1, 2, 3]) }],
    }
    recorder.begin('r1', [msg], opts())
    recorder.finish('r1')
    const full = recorder.getRecord(recorder.listRecords()[0]!.id)
    expect(full?.messages[0]!.text).toBe('[image image/png, 3 bytes]')
  })

  it('caps the in-memory list and keeps the newest', () => {
    const { recorder } = makeRecorder()
    track(recorder)
    for (let i = 0; i < 250; i++) {
      recorder.begin(`r${i}`, [userMessage(`m${i}`)], opts())
      recorder.recordChunk(`r${i}`, { type: 'text', value: `resp${i}` })
      recorder.finish(`r${i}`)
    }
    const list = recorder.listRecords()
    expect(list.length).toBe(200)
    // Newest first.
    expect(list[0]!.responsePreview).toBe('resp249')
  })

  it('skips recording when disabled', () => {
    const { recorder } = makeRecorder()
    track(recorder)
    recorder.setEnabled(false)
    recorder.begin('r1', [userMessage('x')], opts())
    recorder.recordChunk('r1', { type: 'text', value: 'y' })
    recorder.finish('r1')
    expect(recorder.listRecords()).toHaveLength(0)
  })

  it('clears records', () => {
    const { recorder } = makeRecorder()
    track(recorder)
    recorder.begin('r1', [userMessage('x')], opts())
    recorder.finish('r1')
    expect(recorder.listRecords()).toHaveLength(1)
    recorder.clearRecords()
    expect(recorder.listRecords()).toHaveLength(0)
  })

  it('appends a well-formed JSONL line containing no API key', async () => {
    const { recorder, dir } = makeRecorder()
    track(recorder)
    recorder.begin('r1', [userMessage('secret-prompt')], opts({ temperature: 0.7 }))
    recorder.recordChunk('r1', { type: 'text', value: 'answer' })
    recorder.finish('r1')

    const path = join(dir, 'ai-debug.jsonl')
    await waitForFile(path)
    expect(existsSync(path)).toBe(true)
    const lines = readFileSync(path, 'utf8').trim().split('\n')
    expect(lines).toHaveLength(1)
    const parsed = JSON.parse(lines[0]!) as Record<string, unknown>
    expect(parsed.responseText).toBe('answer')
    expect(parsed.modelId).toBe('openai/default/gpt-4o')
    expect(JSON.stringify(parsed).toLowerCase()).not.toContain('apikey')
    expect(JSON.stringify(parsed)).not.toContain('secret-api')
  })
})
