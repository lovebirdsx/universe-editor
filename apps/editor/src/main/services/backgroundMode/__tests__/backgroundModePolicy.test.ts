import { describe, expect, it } from 'vitest'
import { supportsLoginItem } from '../backgroundModePolicy.js'

describe('supportsLoginItem', () => {
  it('allows packaged Windows and macOS builds', () => {
    expect(supportsLoginItem({ isPackaged: true, platform: 'win32', e2e: false })).toBe(true)
    expect(supportsLoginItem({ isPackaged: true, platform: 'darwin', e2e: false })).toBe(true)
  })

  it('rejects development builds', () => {
    expect(supportsLoginItem({ isPackaged: false, platform: 'win32', e2e: false })).toBe(false)
    expect(supportsLoginItem({ isPackaged: false, platform: 'darwin', e2e: false })).toBe(false)
  })

  it('rejects platforms without a supported login item integration', () => {
    expect(supportsLoginItem({ isPackaged: true, platform: 'linux', e2e: false })).toBe(false)
  })

  it('rejects E2E runs even in packaged builds', () => {
    expect(supportsLoginItem({ isPackaged: true, platform: 'win32', e2e: true })).toBe(false)
    expect(supportsLoginItem({ isPackaged: true, platform: 'darwin', e2e: true })).toBe(false)
  })
})
