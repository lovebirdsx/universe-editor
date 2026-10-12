import { describe, it, expect } from 'vitest'
import { present } from '../UpdateIndicator.js'
import type { UpdateState } from '../../../../shared/ipc/updateService.js'

const cv = '0.1.0'

describe('present (title-bar update indicator)', () => {
  it('hides the indicator for idle / disabled', () => {
    expect(present({ type: 'idle', currentVersion: cv })).toBeUndefined()
    expect(present({ type: 'disabled', currentVersion: cv, reason: 'manual' })).toBeUndefined()
  })

  it('checking → spinner glyph, not prominent', () => {
    const v = present({ type: 'checking', currentVersion: cv, explicit: true })
    expect(v?.glyph).toBe('checking')
    expect(v?.prominent).toBe(false)
  })

  it('available → prominent update glyph', () => {
    const v = present({ type: 'available', currentVersion: cv, version: '0.2.0', explicit: false })
    expect(v?.glyph).toBe('available')
    expect(v?.prominent).toBe(true)
    expect(v?.label).toBeTruthy()
    expect(v?.tooltip).toContain('0.2.0')
  })

  it('downloading → progress percent surfaced', () => {
    const v = present({ type: 'downloading', currentVersion: cv, version: '0.2.0', percent: 42 })
    expect(v?.percent).toBe(42)
    expect(v?.label).toContain('42')
    expect(v?.tooltip).toContain('42')
    expect(v?.glyph).toBe('downloading')
  })

  it('downloaded → prominent restart', () => {
    const v = present({ type: 'downloaded', currentVersion: cv, version: '0.2.0' })
    expect(v?.glyph).toBe('downloaded')
    expect(v?.prominent).toBe(true)
    expect(v?.label).toBeTruthy()
  })

  it('every detailed state carries a non-empty label', () => {
    const states: UpdateState[] = [
      { type: 'checking', currentVersion: cv, explicit: false },
      { type: 'available', currentVersion: cv, version: '1', explicit: false },
      { type: 'downloading', currentVersion: cv, version: '1', percent: 0 },
      { type: 'downloaded', currentVersion: cv, version: '1' },
    ]
    for (const s of states) expect(present(s)?.label).toBeTruthy()
  })
})

describe('present marks important updates', () => {
  it('available → says important and still offers the download', () => {
    const v = present({
      type: 'available',
      currentVersion: cv,
      version: '0.2.0',
      explicit: false,
      urgency: 'important',
    })
    expect(v?.glyph).toBe('available')
    expect(v?.prominent).toBe(true)
    expect(v?.label).toContain('Important')
    expect(v?.tooltip).toContain('0.2.0')
  })

  it('available + autoDownload → renders as the running download, never a click target', () => {
    const v = present({
      type: 'available',
      currentVersion: cv,
      version: '0.2.0',
      explicit: false,
      urgency: 'important',
      autoDownload: true,
    })
    expect(v?.glyph).toBe('downloading')
    expect(v?.percent).toBe(0)
    expect(v?.label).toContain('Important')
  })

  it('downloading → urgency reaches the label (guards a dropped field across IPC)', () => {
    const v = present({
      type: 'downloading',
      currentVersion: cv,
      version: '0.2.0',
      percent: 42,
      urgency: 'important',
    })
    expect(v?.label).toContain('Important')
    expect(v?.label).toContain('42')
    expect(v?.percent).toBe(42)
  })

  it('downloaded → urgent restart label', () => {
    const v = present({
      type: 'downloaded',
      currentVersion: cv,
      version: '0.2.0',
      urgency: 'important',
    })
    expect(v?.glyph).toBe('downloaded')
    expect(v?.prominent).toBe(true)
    expect(v?.label).toContain('Important')
  })

  it('a normal update is unchanged by the important variants existing', () => {
    const v = present({ type: 'downloading', currentVersion: cv, version: '0.2.0', percent: 42 })
    expect(v?.label).not.toContain('Important')
  })
})

// Type-level guard: every UpdateState is handled by present() without throwing.
describe('present exhaustiveness', () => {
  it('accepts all state types', () => {
    const states: UpdateState[] = [
      { type: 'idle', currentVersion: cv },
      { type: 'disabled', currentVersion: cv, reason: 'none' },
      { type: 'checking', currentVersion: cv, explicit: false },
      { type: 'available', currentVersion: cv, version: '1', explicit: false },
      { type: 'downloading', currentVersion: cv, version: '1', percent: 0 },
      { type: 'downloaded', currentVersion: cv, version: '1' },
    ]
    for (const s of states) expect(() => present(s)).not.toThrow()
  })
})
