/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Verifies the Phase 1 Extension Host RPC core WITHOUT spawning a process:
 *  two StdioFramingProtocol peers wired into a string pipe, driving the
 *  platform ChannelClient/ChannelServer + ProxyChannel — the same stack the
 *  renderer and the host bootstrap use over real stdio.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import { ChannelClient, ChannelServer, Emitter, ProxyChannel } from '@universe-editor/platform'
import {
  ExtHostChannels,
  StdioFramingProtocol,
  type IExtHostCommands,
} from '@universe-editor/extensions-common'

/** Two framing protocols cross-wired so each one's `write` feeds the other's `onData`. */
function makePair(): { a: StdioFramingProtocol; b: StdioFramingProtocol } {
  const aOut = new Emitter<string>()
  const bOut = new Emitter<string>()
  const a = new StdioFramingProtocol({ write: (f) => bOut.fire(f), onData: aOut.event })
  const b = new StdioFramingProtocol({ write: (f) => aOut.fire(f), onData: bOut.event })
  return { a, b }
}

describe('StdioFramingProtocol', () => {
  it('round-trips a contributed command (renderer ↔ ext host)', async () => {
    const { a, b } = makePair()

    // Ext host side: ChannelServer exposing the commands channel.
    const server = new ChannelServer(b)
    const impl: IExtHostCommands = {
      $executeContributedCommand: (id) =>
        id === 'hello.world'
          ? Promise.resolve('hi from ext host')
          : Promise.reject(new Error(`Unknown command: ${id}`)),
    }
    server.registerChannel(ExtHostChannels.extHostCommands, ProxyChannel.fromService(impl))

    // Renderer side: ChannelClient → typed proxy.
    const client = new ChannelClient(a)
    const proxy = ProxyChannel.toService<IExtHostCommands>(
      client.getChannel(ExtHostChannels.extHostCommands),
    )

    await expect(proxy.$executeContributedCommand('hello.world', [])).resolves.toBe(
      'hi from ext host',
    )
    await expect(proxy.$executeContributedCommand('nope', [])).rejects.toThrow('Unknown command')
  })

  it('reassembles frames split and coalesced across chunks', () => {
    const out = new Emitter<string>()
    const received: string[] = []
    const p = new StdioFramingProtocol({ write: () => {}, onData: out.event })
    p.onMessage((data) => received.push(new TextDecoder().decode(data)))

    // Two frames coalesced, with the second frame split across the boundary.
    out.fire('{"a":1}\n{"b":2}')
    out.fire('\n')
    // Empty lines are ignored.
    out.fire('\n\n')
    out.fire('{"c":3}\n')

    expect(received).toEqual(['{"a":1}', '{"b":2}', '{"c":3}'])
  })

  it('encodes each send as one newline-delimited frame', () => {
    const frames: string[] = []
    const p = new StdioFramingProtocol({
      write: (f) => frames.push(f),
      onData: new Emitter<string>().event,
    })
    p.send(new TextEncoder().encode('{"hello":"world"}'))
    expect(frames).toEqual(['{"hello":"world"}\n'])
  })
})
