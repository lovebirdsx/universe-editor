/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Pure helper tests for the Mobile Devices settings page.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import { chooseDesktopOrigin } from '../mobileDevicesModel.js'

describe('chooseDesktopOrigin', () => {
  it('prefers 127.0.0.1 HTTP over localhost and HTTPS', () => {
    expect(
      chooseDesktopOrigin([
        'https://pc.example.ts.net',
        'http://localhost:47321',
        'http://127.0.0.1:47321',
      ]),
    ).toBe('http://127.0.0.1:47321')
  })

  it('falls back to localhost HTTP when 127.0.0.1 is absent', () => {
    expect(chooseDesktopOrigin(['https://pc.example.ts.net', 'http://localhost:47321'])).toBe(
      'http://localhost:47321',
    )
  })

  it('uses the first HTTPS origin for the LAN tier', () => {
    expect(chooseDesktopOrigin(['https://192.0.2.20:47321', 'https://pc.example.ts.net'])).toBe(
      'https://192.0.2.20:47321',
    )
  })

  it('falls back to the first origin and returns undefined for an empty list', () => {
    expect(chooseDesktopOrigin(['http://192.0.2.20:47321'])).toBe('http://192.0.2.20:47321')
    expect(chooseDesktopOrigin([])).toBeUndefined()
  })
})
