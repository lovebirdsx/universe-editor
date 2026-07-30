/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  Roundtrip pin: encode metadata with OUR runtime constants, decode with
 *  monaco's own TokenMetadata. If a monaco upgrade ever changes the bit
 *  layout, this test fails before any token renders in the wrong color.
 *--------------------------------------------------------------------------------------------*/

import { TokenMetadata } from 'monaco-editor/esm/vs/editor/common/encodedTokenAttributes.js'
import { describe, expect, it } from 'vitest'
import {
  ColorId,
  FontStyle,
  MetadataConsts,
  StandardTokenType,
  encodeTokenMetadata,
} from '../encodedTokenAttributes.js'

describe('encodedTokenAttributes roundtrip (our encode → monaco decode)', () => {
  it('decodes every field back through monaco TokenMetadata', () => {
    const metadata = encodeTokenMetadata({
      languageId: 42,
      tokenType: StandardTokenType.String,
      fontStyle: FontStyle.Italic | FontStyle.Bold,
      foreground: 137,
      background: 201,
      containsBalancedBrackets: true,
    })

    expect(TokenMetadata.getLanguageId(metadata)).toBe(42)
    expect(TokenMetadata.getTokenType(metadata)).toBe(StandardTokenType.String)
    expect(TokenMetadata.getFontStyle(metadata)).toBe(FontStyle.Italic | FontStyle.Bold)
    expect(TokenMetadata.getForeground(metadata)).toBe(137)
    expect(TokenMetadata.getBackground(metadata)).toBe(201)
    expect(TokenMetadata.containsBalancedBrackets(metadata)).toBe(true)
  })

  it('encodes the default null-token exactly like monaco expects', () => {
    // Same shape as VSCode nullTokenizeEncoded: a whole-line token with the
    // default foreground/background, used for over-long-line degradation.
    const metadata = encodeTokenMetadata({
      languageId: 1,
      tokenType: StandardTokenType.Other,
      fontStyle: FontStyle.None,
      foreground: ColorId.DefaultForeground,
      background: ColorId.DefaultBackground,
    })

    expect(TokenMetadata.getLanguageId(metadata)).toBe(1)
    expect(TokenMetadata.getForeground(metadata)).toBe(ColorId.DefaultForeground)
    expect(TokenMetadata.getBackground(metadata)).toBe(ColorId.DefaultBackground)
    expect(TokenMetadata.getFontStyle(metadata)).toBe(FontStyle.None)
    expect(TokenMetadata.getClassNameFromMetadata(metadata)).toBe('mtk1')
  })

  it('drives the mtk class name composition (font-style suffixes)', () => {
    const metadata = encodeTokenMetadata({
      languageId: 0,
      tokenType: StandardTokenType.Comment,
      fontStyle: FontStyle.Italic | FontStyle.Underline | FontStyle.Strikethrough,
      foreground: 7,
      background: 0,
    })
    expect(TokenMetadata.getClassNameFromMetadata(metadata)).toBe('mtk7 mtki mtku mtks')
  })

  it('keeps max field values inside their bit widths (no bleed between fields)', () => {
    const metadata = encodeTokenMetadata({
      languageId: 255, // 8 bits
      tokenType: 3, // 2 bits
      fontStyle: 15, // 4 bits
      foreground: 511, // 9 bits
      background: 255, // 8 bits
      containsBalancedBrackets: true,
    })
    expect(TokenMetadata.getLanguageId(metadata)).toBe(255)
    expect(TokenMetadata.getTokenType(metadata)).toBe(3)
    expect(TokenMetadata.getFontStyle(metadata)).toBe(15)
    expect(TokenMetadata.getForeground(metadata)).toBe(511)
    expect(TokenMetadata.getBackground(metadata)).toBe(255)
    expect(TokenMetadata.containsBalancedBrackets(metadata)).toBe(true)
    // And the raw masks agree with monaco's hard-coded decoder numbers.
    expect(MetadataConsts.LANGUAGEID_MASK).toBe(255)
    expect(MetadataConsts.TOKEN_TYPE_MASK).toBe(768)
    expect(MetadataConsts.BALANCED_BRACKETS_MASK).toBe(1024)
    expect(MetadataConsts.FONT_STYLE_MASK).toBe(30720)
    expect(MetadataConsts.FOREGROUND_MASK).toBe(16744448)
    expect(MetadataConsts.BACKGROUND_MASK).toBe(4278190080)
  })
})
