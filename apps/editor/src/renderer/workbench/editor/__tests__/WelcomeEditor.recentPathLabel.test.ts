/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import { REMOTE_SCHEME, URI } from '@universe-editor/platform'
import { recentPathLabel } from '../WelcomeEditor.js'

describe('recentPathLabel', () => {
  it('formats WSL folders as "WSL: <distro> · <path>"', () => {
    const folder = URI.from({
      scheme: REMOTE_SCHEME,
      authority: 'wsl+ubuntu-24.04',
      path: '/home/dev/proj',
    })
    expect(recentPathLabel(folder)).toBe('WSL: ubuntu-24.04 · /home/dev/proj')
  })

  it('formats ssh folders as "SSH: <authority> · <path>"', () => {
    const folder = URI.from({ scheme: REMOTE_SCHEME, authority: 'devbox', path: '/srv/app' })
    expect(recentPathLabel(folder)).toBe('SSH: devbox · /srv/app')
  })

  it('formats a Windows remote folder path with display separators', () => {
    const folder = URI.from({
      scheme: REMOTE_SCHEME,
      authority: 'winbox',
      path: '/E:/workspace/foo',
    })
    expect(recentPathLabel(folder)).toBe('SSH: winbox · E:\\workspace\\foo')
  })

  it('keeps local folders unchanged', () => {
    const folder = URI.file('/home/dev/proj')
    expect(recentPathLabel(folder)).toBe(folder.fsPath)
  })
})
