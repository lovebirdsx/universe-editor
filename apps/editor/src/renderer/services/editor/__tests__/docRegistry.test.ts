/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Tests for docRegistry — category-aware lookups over the bootstrap-warmed
 *  cache: per-category isolation, locale fallback within a category, and the
 *  title helper.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it } from 'vitest'
import {
  getDocTitle,
  initDocRegistry,
  initUserDocsForTests,
  isDocId,
  resolveDoc,
} from '../docRegistry.js'
import { setCurrentLocale } from '../../../../shared/i18n/availableLocales.js'

function emptyDocs() {
  return { user: {}, extensionDev: {} }
}

describe('docRegistry', () => {
  afterEach(() => {
    initDocRegistry(emptyDocs())
    setCurrentLocale('zh-CN')
  })

  it('resolves docs independently per category', () => {
    initDocRegistry({
      user: { 'zh-CN': { index: '# 用户指南' }, 'en-US': {} },
      extensionDev: { 'zh-CN': { README: '# 扩展开发' }, 'en-US': {} },
    })

    expect(resolveDoc('index')?.content).toBe('# 用户指南')
    expect(resolveDoc('index', 'extensionDev')).toBeUndefined()
    expect(resolveDoc('README', 'extensionDev')?.content).toBe('# 扩展开发')
    expect(resolveDoc('README')).toBeUndefined()
  })

  it('falls back to zh-CN when the active locale lacks the doc in that category', () => {
    setCurrentLocale('en-US')
    initDocRegistry({
      user: { 'zh-CN': {}, 'en-US': {} },
      extensionDev: { 'zh-CN': { README: '# 扩展开发' }, 'en-US': {} },
    })

    const resolved = resolveDoc('README', 'extensionDev')
    expect(resolved?.content).toBe('# 扩展开发')
    expect(resolved?.locale).toBe('zh-CN')
  })

  it('isDocId respects the category', () => {
    initDocRegistry({
      user: { 'zh-CN': { index: '# 用户指南' }, 'en-US': {} },
      extensionDev: { 'zh-CN': { README: '# 扩展开发' }, 'en-US': {} },
    })

    expect(isDocId('index')).toBe(true)
    expect(isDocId('index', 'extensionDev')).toBe(false)
    expect(isDocId('README', 'extensionDev')).toBe(true)
  })

  it('getDocTitle reads the H1 from the category doc', () => {
    initUserDocsForTests({ 'zh-CN': { index: '# 用户指南' }, 'en-US': {} })
    expect(getDocTitle('index')).toBe('用户指南')
  })

  it('initUserDocsForTests clears the extensionDev category', () => {
    initDocRegistry({
      user: { 'zh-CN': {}, 'en-US': {} },
      extensionDev: { 'zh-CN': { README: '# 扩展开发' }, 'en-US': {} },
    })
    initUserDocsForTests({})
    expect(resolveDoc('README', 'extensionDev')).toBeUndefined()
  })
})
