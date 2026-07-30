/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Adapted from Microsoft VSCode src/vs/editor/common/encodedTokenAttributes.ts.
 *
 *  monaco's const enums are erased at build time, so the bit-layout constants
 *  must live as runtime values here. The layout is pinned by the roundtrip
 *  unit test (encode with these constants → decode with monaco's own
 *  `TokenMetadata` from esm/vs/editor/common/encodedTokenAttributes.js).
 *--------------------------------------------------------------------------------------------*/

/**
 * The binary metadata format (32 bits):
 * - -------------------------------------------
 *     3322 2222 2222 1111 1111 1100 0000 0000
 *     1098 7654 3210 9876 5432 1098 7654 3210
 * - -------------------------------------------
 *     xxxx xxxx xxxx xxxx xxxx xxxx xxxx xxxx
 *     bbbb bbbb ffff ffff fFFF FBTT LLLL LLLL
 * - -------------------------------------------
 *  - L = LanguageId (8 bits)
 *  - T = StandardTokenType (2 bits)
 *  - B = Balanced bracket (1 bit)
 *  - F = FontStyle (4 bits)
 *  - f = foreground color (9 bits)
 *  - b = background color (8 bits)
 */
export const MetadataConsts = {
  LANGUAGEID_MASK: 0b00000000_00000000_00000000_11111111,
  TOKEN_TYPE_MASK: 0b00000000_00000000_00000011_00000000,
  BALANCED_BRACKETS_MASK: 0b00000000_00000000_00000100_00000000,
  FONT_STYLE_MASK: 0b00000000_00000000_01111000_00000000,
  FOREGROUND_MASK: 0b00000000_11111111_10000000_00000000,
  BACKGROUND_MASK: 0b11111111_00000000_00000000_00000000,

  LANGUAGEID_OFFSET: 0,
  TOKEN_TYPE_OFFSET: 8,
  BALANCED_BRACKETS_OFFSET: 10,
  FONT_STYLE_OFFSET: 11,
  FOREGROUND_OFFSET: 15,
  BACKGROUND_OFFSET: 24,
} as const

export const FontStyle = {
  NotSet: -1,
  None: 0,
  Italic: 1,
  Bold: 2,
  Underline: 4,
  Strikethrough: 8,
} as const
export type FontStyle = (typeof FontStyle)[keyof typeof FontStyle]

export const ColorId = {
  None: 0,
  DefaultForeground: 1,
  DefaultBackground: 2,
} as const
export type ColorId = (typeof ColorId)[keyof typeof ColorId]

export const StandardTokenType = {
  Other: 0,
  Comment: 1,
  String: 2,
  RegEx: 3,
} as const
export type StandardTokenType = (typeof StandardTokenType)[keyof typeof StandardTokenType]

/** Combine the individual fields into the collapsed 32-bit metadata. */
export function encodeTokenMetadata(fields: {
  readonly languageId: number
  readonly tokenType: StandardTokenType
  readonly fontStyle: FontStyle
  readonly foreground: number
  readonly background: number
  readonly containsBalancedBrackets?: boolean
}): number {
  return (
    ((fields.languageId << MetadataConsts.LANGUAGEID_OFFSET) |
      (fields.tokenType << MetadataConsts.TOKEN_TYPE_OFFSET) |
      ((fields.containsBalancedBrackets === true ? 1 : 0) <<
        MetadataConsts.BALANCED_BRACKETS_OFFSET) |
      (fields.fontStyle << MetadataConsts.FONT_STYLE_OFFSET) |
      (fields.foreground << MetadataConsts.FOREGROUND_OFFSET) |
      (fields.background << MetadataConsts.BACKGROUND_OFFSET)) >>>
    0
  )
}
