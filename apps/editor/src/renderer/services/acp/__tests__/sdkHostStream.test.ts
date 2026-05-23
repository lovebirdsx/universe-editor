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
import { describe, expect, it } from 'vitest'
import { Emitter, type IDisposable } from '@universe-editor/platform'
import type {
  AcpExitEvent,
  AcpStdioChunk,
  IAcpHostService,
} from '../../../../shared/ipc/acpHostService.js'
import { createSdkHostStream } from '../sdkHostStream.js'

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
})
