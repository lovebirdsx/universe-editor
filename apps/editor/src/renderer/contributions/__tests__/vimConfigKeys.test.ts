/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  `affectsConfiguration` is an exact match, so `VimModeService` lists the `vim.*`
 *  keys it reacts to by hand. A key registered in settings but missing from that
 *  list would silently stop reacting to edits; this keeps the two in lockstep.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it } from 'vitest'
import { ConfigurationRegistry } from '@universe-editor/platform'
import { SettingsContribution } from '../SettingsContribution.js'
import { VIM_SERVICE_CONFIG_KEYS } from '../../services/vim/vimModeService.js'

/** Read by the editor Vim core or a surface component, not by the workbench service. */
const EDITOR_CORE_ONLY_KEYS = [
  'vim.searchCaseSensitivity',
  'vim.highlightSearch',
  'vim.useSystemClipboard',
  'vim.prompt.defaultMode',
]

describe('vim.* configuration keys', () => {
  let contribution: SettingsContribution | undefined
  afterEach(() => {
    contribution?.dispose()
    contribution = undefined
  })

  it('VimModeService reacts to exactly the registered vim.* keys (minus editor-core-only ones)', () => {
    contribution = new SettingsContribution()
    const registered = new Set<string>()
    for (const node of ConfigurationRegistry.getConfigurationNodes()) {
      for (const key of Object.keys(node.properties ?? {})) {
        if (key.startsWith('vim.')) registered.add(key)
      }
    }
    const handled = new Set<string>([...VIM_SERVICE_CONFIG_KEYS, ...EDITOR_CORE_ONLY_KEYS])
    expect([...handled].sort()).toEqual([...registered].sort())
  })

  it('has no duplicate service keys', () => {
    expect(new Set(VIM_SERVICE_CONFIG_KEYS).size).toBe(VIM_SERVICE_CONFIG_KEYS.length)
  })
})
