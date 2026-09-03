/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import { pathTail, shortenScopeLabel } from '../scopeLabel.js'

describe('shortenScopeLabel', () => {
  it('keeps a single segment verbatim', () => {
    expect(shortenScopeLabel('client')).toBe('client')
  })

  it('keeps two segments intact', () => {
    expect(shortenScopeLabel('packages/client')).toBe('packages/client')
  })

  it('folds the middle of a deep path', () => {
    expect(shortenScopeLabel('packages/client/src/app/editor')).toBe('packages/…/editor')
  })

  it('folds backslash-separated paths the same way', () => {
    expect(shortenScopeLabel('packages\\client\\editor')).toBe('packages/…/editor')
  })

  it('ignores empty segments from leading/duplicate separators', () => {
    expect(shortenScopeLabel('/packages//client/')).toBe('packages/client')
  })
})

describe('pathTail', () => {
  it('returns the last segment of a posix path', () => {
    expect(pathTail('/work/src/client')).toBe('client')
  })

  it('returns the last segment of a windows path', () => {
    expect(pathTail('C:\\work\\src\\client')).toBe('client')
  })

  it('falls back to the input when there is no segment', () => {
    expect(pathTail('/')).toBe('/')
  })
})
