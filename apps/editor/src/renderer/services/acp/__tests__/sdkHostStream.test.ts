/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/renderer/services/acp/sdkHostStream.ts
 *
 *  Drives the adapter with a tiny in-memory IAcpHostService and verifies:
 *  - inbound bytes from the host land as decoded SDK messages on the readable
 *    side (newline-delimited JSON → AnyMessage)
 *  - outbound SDK messages serialize into a single `writeStdin` call ending in
 *    a newline
 *  - exit/close paths close the readable side
 *--------------------------------------------------------------------------------------------*/

import type { AnyMessage } from '@agentclientprotocol/sdk'
import { describe, expect, it, vi } from 'vitest'
import { Emitter, type IDisposable } from '@universe-editor/platform'
import type {
  AcpExitEvent,
  AcpStdioChunk,
  IAcpHostService,
} from '../../../../shared/ipc/acpHostService.js'
import { createSdkHostStream, StdoutLineGuard } from '../sdkHostStream.js'

interface InMemoryHostHarness extends IDisposable {
  readonly host: IAcpHostService
  readonly handle: string
  inject(data: string): void
  written(): readonly string[]
  exit(code: number | null, signal: string | null): void
}

function createInMemoryHost(): InMemoryHostHarness {
  const onStdout = new Emitter<AcpStdioChunk>()
  const onStderr = new Emitter<AcpStdioChunk>()
  const onExit = new Emitter<AcpExitEvent>()
  const handle = 'mem-' + Math.random().toString(36).slice(2, 10)
  const writes: string[] = []
  const host: IAcpHostService = {
    _serviceBrand: undefined,
    onStdout: onStdout.event,
    onStderr: onStderr.event,
    onExit: onExit.event,
    start: () => Promise.resolve({ handle }),
    writeStdin: (_h, data) => {
      writes.push(data)
      return Promise.resolve()
    },
    stop: () => Promise.resolve(),
    probe: () => Promise.resolve(true),
  }
  return {
    host,
    handle,
    inject(data) {
      onStdout.fire({ handle, data })
    },
    written() {
      return writes
    },
    exit(code, signal) {
      onExit.fire({ handle, code, signal })
    },
    dispose() {
      onStdout.dispose()
      onStderr.dispose()
      onExit.dispose()
    },
  }
}

const readNextMessage = async (
  readable: ReadableStream<AnyMessage>,
): Promise<{ value: AnyMessage | undefined; done: boolean }> => {
  const reader = readable.getReader()
  try {
    const r = await reader.read()
    return { value: r.value, done: r.done }
  } finally {
    reader.releaseLock()
  }
}

describe('createSdkHostStream', () => {
  it('decodes inbound stdout bytes into SDK messages', async () => {
    const harness = createInMemoryHost()
    const adapter = createSdkHostStream(harness.host, harness.handle)

    const payload: AnyMessage = {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: 1 },
    }
    harness.inject(JSON.stringify(payload) + '\n')

    const { value, done } = await readNextMessage(adapter.stream.readable)
    expect(done).toBe(false)
    expect(value).toEqual(payload)

    adapter.dispose()
    harness.dispose()
  })

  it('encodes outbound messages as a single newline-terminated JSON line', async () => {
    const harness = createInMemoryHost()
    const adapter = createSdkHostStream(harness.host, harness.handle)

    const msg: AnyMessage = { jsonrpc: '2.0', id: 7, result: { ok: true } }
    const writer = adapter.stream.writable.getWriter()
    await writer.write(msg)
    writer.releaseLock()

    const writes = harness.written()
    expect(writes).toHaveLength(1)
    expect(writes[0]!.endsWith('\n')).toBe(true)
    expect(JSON.parse(writes[0]!.trim())).toEqual(msg)

    adapter.dispose()
    harness.dispose()
  })

  it('ignores stdout chunks for other handles', async () => {
    const onStdout = new Emitter<AcpStdioChunk>()
    const onStderr = new Emitter<AcpStdioChunk>()
    const onExit = new Emitter<AcpExitEvent>()
    const host: IAcpHostService = {
      _serviceBrand: undefined,
      onStdout: onStdout.event,
      onStderr: onStderr.event,
      onExit: onExit.event,
      start: () => Promise.resolve({ handle: 'h1' }),
      writeStdin: () => Promise.resolve(),
      stop: () => Promise.resolve(),
      probe: () => Promise.resolve(true),
    }
    const adapter = createSdkHostStream(host, 'h1')

    const mine: AnyMessage = { jsonrpc: '2.0', method: 'mine', params: null }
    onStdout.fire({
      handle: 'h2',
      data: JSON.stringify({ jsonrpc: '2.0', method: 'other', params: null }) + '\n',
    })
    onStdout.fire({ handle: 'h1', data: JSON.stringify(mine) + '\n' })

    const { value, done } = await readNextMessage(adapter.stream.readable)
    expect(done).toBe(false)
    expect(value).toEqual(mine)

    adapter.dispose()
    onStdout.dispose()
    onStderr.dispose()
    onExit.dispose()
  })

  it('closes the readable side when the host emits exit', async () => {
    const harness = createInMemoryHost()
    const adapter = createSdkHostStream(harness.host, harness.handle)

    harness.exit(0, null)
    const reader = adapter.stream.readable.getReader()
    try {
      const r = await reader.read()
      expect(r.done).toBe(true)
    } finally {
      reader.releaseLock()
    }

    adapter.dispose()
    harness.dispose()
  })

  it('dispose() unsubscribes host listeners so later chunks do not enqueue', async () => {
    const harness = createInMemoryHost()
    const adapter = createSdkHostStream(harness.host, harness.handle)
    adapter.dispose()

    // After dispose, injecting more data must not throw — but the readable
    // side is also closed so further reads see done=true.
    harness.inject(JSON.stringify({ jsonrpc: '2.0', method: 'after_dispose', params: null }) + '\n')

    const reader = adapter.stream.readable.getReader()
    try {
      const r = await reader.read()
      expect(r.done).toBe(true)
    } finally {
      reader.releaseLock()
    }
    harness.dispose()
  })

  it('invokes tap.onStdout / tap.onStdin with decoded text on both directions', async () => {
    const harness = createInMemoryHost()
    const stdoutSeen: string[] = []
    const stdinSeen: string[] = []
    const adapter = createSdkHostStream(harness.host, harness.handle, {
      onStdout: (t) => stdoutSeen.push(t),
      onStdin: (t) => stdinSeen.push(t),
    })

    const inbound: AnyMessage = { jsonrpc: '2.0', method: 'in', params: null }
    const outbound: AnyMessage = { jsonrpc: '2.0', id: 1, result: { ok: true } }

    harness.inject(JSON.stringify(inbound) + '\n')
    await readNextMessage(adapter.stream.readable)

    const writer = adapter.stream.writable.getWriter()
    await writer.write(outbound)
    writer.releaseLock()

    expect(stdoutSeen).toHaveLength(1)
    expect(JSON.parse(stdoutSeen[0]!.trim())).toEqual(inbound)
    expect(stdinSeen).toHaveLength(1)
    expect(JSON.parse(stdinSeen[0]!.trim())).toEqual(outbound)

    adapter.dispose()
    harness.dispose()
  })
})

describe('StdoutLineGuard', () => {
  const enc = (s: string): Uint8Array => new TextEncoder().encode(s)
  const dec = (parts: Uint8Array[]): string =>
    parts.map((p) => new TextDecoder().decode(p)).join('')

  it('passes short lines through, splitting multi-line chunks correctly', () => {
    const guard = new StdoutLineGuard(() => {}, 16)
    const out = guard.push(enc('ab\ncd\nef'))
    expect(dec(out)).toBe('ab\ncd\n')
    expect(dec(guard.push(enc('gh\n')))).toBe('efgh\n')
  })

  it('drops an over-long line arriving in a single chunk, keeping the lines around it', () => {
    const onWarn = vi.fn()
    const guard = new StdoutLineGuard(onWarn, 16)
    const out = guard.push(enc('ok1\n' + 'x'.repeat(100) + '\nok2\n'))
    // The oversized line collapses to a bare newline (SDK skips empty lines);
    // its neighbours are byte-identical.
    expect(dec(out)).toBe('ok1\n\nok2\n')
    expect(onWarn).toHaveBeenCalledTimes(1)
  })

  it('drops an over-long line spanning multiple chunks and warns only once per line', () => {
    const onWarn = vi.fn()
    const guard = new StdoutLineGuard(onWarn, 16)
    expect(dec(guard.push(enc('pre\n' + 'x'.repeat(10))))).toBe('pre\n')
    // Still under budget: nothing forwarded yet, nothing dropped.
    expect(dec(guard.push(enc('y'.repeat(10))))).toBe('')
    expect(onWarn).toHaveBeenCalledTimes(1)
    // In drop mode the rest of the line is discarded, however many chunks it takes.
    expect(dec(guard.push(enc('z'.repeat(50))))).toBe('')
    expect(dec(guard.push(enc('tail\nnext\n')))).toBe('\nnext\n')
    expect(onWarn).toHaveBeenCalledTimes(1)
  })

  it('accepts a line at exactly the budget', () => {
    const onWarn = vi.fn()
    const guard = new StdoutLineGuard(onWarn, 16)
    const line = 'x'.repeat(16)
    expect(dec(guard.push(enc(line + '\n')))).toBe(line + '\n')
    expect(onWarn).not.toHaveBeenCalled()
  })

  it('flush returns a trailing unterminated line, and nothing after a dropped line', () => {
    const guard = new StdoutLineGuard(() => {}, 16)
    expect(dec(guard.push(enc('partial')))).toBe('')
    expect(dec(guard.flush())).toBe('partial')

    const guard2 = new StdoutLineGuard(() => {}, 4)
    guard2.push(enc('toolong'))
    expect(guard2.flush()).toEqual([])
  })
})

describe('createSdkHostStream line guard integration', () => {
  it('a >16MB stdout line is dropped wholesale; the following message still decodes', async () => {
    const harness = createInMemoryHost()
    const adapter = createSdkHostStream(harness.host, harness.handle)

    const hugeLine = JSON.stringify({
      jsonrpc: '2.0',
      method: 'bloated',
      params: { blob: 'x'.repeat(17 * 1024 * 1024) },
    })
    const followUp: AnyMessage = { jsonrpc: '2.0', id: 9, result: { alive: true } }
    harness.inject(hugeLine + '\n' + JSON.stringify(followUp) + '\n')

    const { value, done } = await readNextMessage(adapter.stream.readable)
    expect(done).toBe(false)
    expect(value).toEqual(followUp)

    adapter.dispose()
    harness.dispose()
  })
})
