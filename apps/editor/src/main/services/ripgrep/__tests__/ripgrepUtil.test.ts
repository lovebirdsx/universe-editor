/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/main/services/ripgrep/ripgrepUtil.ts
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import { expandIncludeGlob } from '../ripgrepUtil.js'

describe('expandIncludeGlob', () => {
  it('expands a bare directory pattern to match at any depth and its contents', () => {
    expect(expandIncludeGlob('d.地图/110')).toEqual(['**/d.地图/110/**', '**/d.地图/110'])
    expect(expandIncludeGlob('110')).toEqual(['**/110/**', '**/110'])
  })

  it('anchors ./-prefixed patterns at the workspace root', () => {
    expect(expandIncludeGlob('./d.地图/110')).toEqual(['d.地图/110/**', 'd.地图/110'])
    expect(expandIncludeGlob('./src/*.ts')).toEqual(['src/*.ts/**', 'src/*.ts'])
  })

  it('normalizes backslashes and trailing slashes', () => {
    expect(expandIncludeGlob('d.地图\\110\\')).toEqual(['**/d.地图/110/**', '**/d.地图/110'])
  })

  it('converts leading-dot extension shorthand like VSCode', () => {
    expect(expandIncludeGlob('.json')).toEqual(['**/*.json/**', '**/*.json'])
  })

  it('keeps glob-magic patterns under a **/ prefix variant', () => {
    expect(expandIncludeGlob('*.ts')).toEqual(['**/*.ts/**', '**/*.ts'])
    expect(expandIncludeGlob('**/*.ts')).toEqual(['**/*.ts/**', '**/*.ts'])
    expect(expandIncludeGlob('src/*.ts')).toEqual(['**/src/*.ts/**', '**/src/*.ts'])
  })

  it('returns an empty list for empty patterns', () => {
    expect(expandIncludeGlob('')).toEqual([])
    expect(expandIncludeGlob('/')).toEqual([])
  })
})
