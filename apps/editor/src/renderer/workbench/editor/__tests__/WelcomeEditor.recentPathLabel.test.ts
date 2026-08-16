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
      path: '/home/xiao/proj',
    })
    expect(recentPathLabel(folder)).toBe('WSL: ubuntu-24.04 · /home/xiao/proj')
  })

  it('formats ssh folders as "SSH: <authority> · <path>"', () => {
    const folder = URI.from({ scheme: REMOTE_SCHEME, authority: 'devbox', path: '/srv/app' })
    expect(recentPathLabel(folder)).toBe('SSH: devbox · /srv/app')
  })

  it('keeps local folders unchanged', () => {
    const folder = URI.file('/home/xiao/proj')
    expect(recentPathLabel(folder)).toBe(folder.fsPath)
  })
})
