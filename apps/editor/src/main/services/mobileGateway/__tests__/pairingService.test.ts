import { describe, expect, it } from 'vitest'
import { normalizePairCode } from '@universe-editor/mobile-protocol'
import { PairingService } from '../pairingService.js'

function fixedClock(start = 1_000): { service: PairingService; advance: (ms: number) => void } {
  let now = start
  const service = new PairingService({ now: () => now })
  return { service, advance: (ms: number) => (now += ms) }
}

describe('PairingService', () => {
  it('issues a well-formed code and consumes it once', () => {
    const { service } = fixedClock()
    const session = service.start()
    expect(normalizePairCode(session.code)).toHaveLength(8)
    expect(session.expiresAt).toBe(121_000)

    expect(service.redeem(session.code, '192.0.2.10')).toBe('ok')
    expect(service.redeem(session.code, '192.0.2.10')).toBe('invalid')
  })

  it('accepts the display form and lowercase input', () => {
    const { service } = fixedClock()
    const { code } = service.start()
    const display = `${code.slice(0, 4)}-${code.slice(4)}`.toLowerCase()
    expect(service.redeem(display, '192.0.2.10')).toBe('ok')
  })

  it('expires after the TTL', () => {
    const { service, advance } = fixedClock()
    const session = service.start()
    advance(121_000)
    expect(service.redeem(session.code, '192.0.2.10')).toBe('expired')
    expect(service.redeem(session.code, '192.0.2.10')).toBe('invalid')
  })

  it('invalidates the previous code when a new one is generated', () => {
    const { service } = fixedClock()
    const first = service.start()
    const second = service.start()
    expect(service.redeem(first.code, '192.0.2.10')).toBe('invalid')
    expect(service.redeem(second.code, '192.0.2.10')).toBe('ok')
  })

  it('cancels the current code', () => {
    const { service } = fixedClock()
    const session = service.start()
    service.cancel()
    expect(service.redeem(session.code, '192.0.2.10')).toBe('invalid')
  })

  it('rate limits failures per remote address', () => {
    const { service } = fixedClock()
    service.start()
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(service.redeem('WRONG123', '192.0.2.10')).toBe('invalid')
    }
    expect(service.redeem('WRONG123', '192.0.2.10')).toBe('rate_limited')
    expect(service.redeem('WRONG123', '192.0.2.11')).toBe('invalid')
  })

  it('invalidates the code after too many consecutive failures', () => {
    const { service } = fixedClock()
    const { code } = service.start()
    for (let attempt = 0; attempt < 10; attempt += 1) {
      expect(service.redeem('WRONG123', `192.0.2.${attempt + 10}`)).toBe('invalid')
    }
    expect(service.redeem(code, '192.0.2.99')).toBe('invalid')
  })

  it('keeps a configured e2e code valid without expiry and without consumption', () => {
    let now = 1_000
    const service = new PairingService({ now: () => now, fixedCode: 'ABCD2345' })
    const session = service.start()
    expect(session.code).toBe('ABCD2345')
    expect(session.expiresAt).toBe(Number.MAX_SAFE_INTEGER)

    now += 10 * 24 * 60 * 60 * 1000
    expect(service.redeem('ABCD-2345', '192.0.2.10')).toBe('ok')
    expect(service.redeem('ABCD2345', '192.0.2.10')).toBe('ok')
  })
})
