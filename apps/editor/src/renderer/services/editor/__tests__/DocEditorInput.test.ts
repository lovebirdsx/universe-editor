/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Tests for DocEditorInput — category-aware resource identity and
 *  serialization round-trip, including the legacy (category-less) payload
 *  falling back to the user guide.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it } from 'vitest'
import { DocEditorInput } from '../DocEditorInput.js'
import { initDocRegistry } from '../docRegistry.js'
import { setCurrentLocale } from '../../../../shared/i18n/availableLocales.js'

describe('DocEditorInput', () => {
  afterEach(() => {
    initDocRegistry({ user: {}, extensionDev: {} })
    setCurrentLocale('zh-CN')
  })

  it('keeps the user-guide resource path flat for back-compat', () => {
    expect(new DocEditorInput('index').resource.path).toBe('/doc/index')
  })

  it('nests non-user categories under their own resource segment', () => {
    expect(new DocEditorInput('README', 'extensionDev').resource.path).toBe(
      '/doc/extensionDev/README',
    )
  })

  it('distinguishes categories by id so same-named docs do not dedupe', () => {
    expect(new DocEditorInput('README').id).not.toBe(
      new DocEditorInput('README', 'extensionDev').id,
    )
  })

  it('round-trips category through serialize/deserialize', () => {
    initDocRegistry({
      user: { 'zh-CN': {}, 'en-US': {} },
      extensionDev: { 'zh-CN': { README: '# 扩展开发' }, 'en-US': {} },
    })
    const input = new DocEditorInput('README', 'extensionDev')
    const restored = DocEditorInput.deserialize(input.serialize())
    expect(restored?.category).toBe('extensionDev')
    expect(restored?.docId).toBe('README')
  })

  it('deserializes legacy category-less payloads as user-guide docs', () => {
    initDocRegistry({
      user: { 'zh-CN': { index: '# 用户指南' }, 'en-US': {} },
      extensionDev: { 'zh-CN': {}, 'en-US': {} },
    })
    const restored = DocEditorInput.deserialize({ docId: 'index' })
    expect(restored?.category).toBe('user')
  })

  it('returns null when the docId is unknown in its category', () => {
    initDocRegistry({
      user: { 'zh-CN': { index: '# 用户指南' }, 'en-US': {} },
      extensionDev: { 'zh-CN': {}, 'en-US': {} },
    })
    expect(DocEditorInput.deserialize({ docId: 'index', category: 'extensionDev' })).toBeNull()
  })
})
