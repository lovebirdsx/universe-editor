import { describe, expect, it } from 'vitest'
import { Emitter } from '@universe-editor/platform'
import { StdioFramingProtocol, type StdioTransport } from '../stdioProtocol.js'

/** A loopback transport whose `onData` can be driven directly, capturing writes. */
class FakeTransport implements StdioTransport {
  readonly writes: string[] = []
  private readonly _onData = new Emitter<string>()
  readonly onData = this._onData.event

  write(frame: string): void {
    this.writes.push(frame)
  }

  /** Simulate raw bytes arriving from the other peer. */
  feed(chunk: string): void {
    this._onData.fire(chunk)
  }
}

const enc = (s: string): Uint8Array => new TextEncoder().encode(s)
const dec = (b: Uint8Array): string => new TextDecoder().decode(b)

describe('StdioFramingProtocol', () => {
  it('appends a newline delimiter on send', () => {
    const t = new FakeTransport()
    const p = new StdioFramingProtocol(t)
    p.send(enc('{"a":1}'))
    expect(t.writes).toEqual(['{"a":1}\n'])
    p.dispose()
  })

  it('emits one message per complete line', () => {
    const t = new FakeTransport()
    const p = new StdioFramingProtocol(t)
    const got: string[] = []
    p.onMessage((m) => got.push(dec(m)))

    t.feed('one\ntwo\n')
    expect(got).toEqual(['one', 'two'])
    p.dispose()
  })

  it('buffers a partial frame until its newline arrives (coalesced across chunks)', () => {
    const t = new FakeTransport()
    const p = new StdioFramingProtocol(t)
    const got: string[] = []
    p.onMessage((m) => got.push(dec(m)))

    t.feed('hel')
    expect(got).toEqual([])
    t.feed('lo\nwor')
    expect(got).toEqual(['hello'])
    t.feed('ld\n')
    expect(got).toEqual(['hello', 'world'])
    p.dispose()
  })

  it('skips empty frames (blank lines)', () => {
    const t = new FakeTransport()
    const p = new StdioFramingProtocol(t)
    const got: string[] = []
    p.onMessage((m) => got.push(dec(m)))

    t.feed('a\n\n\nb\n')
    expect(got).toEqual(['a', 'b'])
    p.dispose()
  })

  it('reassembles a frame spread across many chunks (large-payload path)', () => {
    const t = new FakeTransport()
    const p = new StdioFramingProtocol(t)
    const got: string[] = []
    p.onMessage((m) => got.push(dec(m)))

    const big = 'x'.repeat(1024 * 1024)
    const payload = big + '\ntrailer\npartial'
    for (let i = 0; i < payload.length; i += 64 * 1024) {
      t.feed(payload.slice(i, i + 64 * 1024))
    }
    expect(got).toEqual([big, 'trailer'])
    t.feed(' done\n')
    expect(got).toEqual([big, 'trailer', 'partial done'])
    p.dispose()
  })

  it('round-trips send → wire → ingest between two protocols', () => {
    // Peer A writes into a shared wire that peer B ingests, and vice versa.
    const wireA = new FakeTransport()
    const wireB = new FakeTransport()
    const a = new StdioFramingProtocol(wireA)
    const b = new StdioFramingProtocol(wireB)
    // A's writes are fed into B, B's writes into A.
    wireA.write = (frame) => wireB.feed(frame)
    wireB.write = (frame) => wireA.feed(frame)

    const atB: string[] = []
    b.onMessage((m) => atB.push(dec(m)))
    a.send(enc('{"hello":"world"}'))
    expect(atB).toEqual(['{"hello":"world"}'])

    a.dispose()
    b.dispose()
  })
})
