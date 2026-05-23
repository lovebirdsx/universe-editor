/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/renderer/services/acp/acpFocusService.ts
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import { AcpFocusService } from '../acpFocusService.js'

describe('AcpFocusService', () => {
  let svc: AcpFocusService
  afterEach(() => {
    svc?.dispose()
  })

  it('requestFocus fires onDidRequestFocus once per call', () => {
    svc = new AcpFocusService()
    const listener = vi.fn()
    svc.onDidRequestFocus(listener)
    svc.requestFocus()
    svc.requestFocus()
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('multiple subscribers all receive the same fire', () => {
    svc = new AcpFocusService()
    const a = vi.fn()
    const b = vi.fn()
    svc.onDidRequestFocus(a)
    svc.onDidRequestFocus(b)
    svc.requestFocus()
    expect(a).toHaveBeenCalledTimes(1)
    expect(b).toHaveBeenCalledTimes(1)
  })

  it('unsubscribed listener stops receiving fires', () => {
    svc = new AcpFocusService()
    const listener = vi.fn()
    const sub = svc.onDidRequestFocus(listener)
    svc.requestFocus()
    sub.dispose()
    svc.requestFocus()
    expect(listener).toHaveBeenCalledTimes(1)
  })
})
