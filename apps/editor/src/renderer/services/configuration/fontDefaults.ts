export const WORKBENCH_FONT_FAMILY_DEFAULT =
  "'Roboto', system-ui, -apple-system, 'Segoe UI', sans-serif"

export const EDITOR_FONT_FAMILY_DEFAULT = 'Consolas'

export const EDITOR_LINE_HEIGHT_DEFAULT = 0 // 0 = 按字号自动
export const EDITOR_LETTER_SPACING_DEFAULT = 0
export const EDITOR_FONT_WEIGHT_DEFAULT = 'normal'

export const AGENT_FONT_SIZE_DEFAULT = 14

export const OUTPUT_FONT_SIZE_DEFAULT = 14
export const OUTPUT_FONT_FAMILY_DEFAULT = "'Cascadia Code', 'Consolas', 'Courier New', monospace"

export const TERMINAL_FONT_SIZE_DEFAULT = 14
export const TERMINAL_FONT_FAMILY_DEFAULT = 'Consolas, "Courier New", monospace'

export function normalizeFontFamily(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : fallback
}

export interface ILanguageFontOverride {
  fontFamily?: string
  fontSize?: number
}

export type LanguageFontsMap = Record<string, ILanguageFontOverride>

export function resolveLanguageFonts(
  globalFamily: string,
  globalSize: number,
  map: LanguageFontsMap,
  languageId: string,
): { fontFamily: string; fontSize: number } {
  const override = map[languageId]
  return {
    fontFamily: normalizeFontFamily(override?.fontFamily, globalFamily),
    fontSize:
      typeof override?.fontSize === 'number' && override.fontSize > 0
        ? override.fontSize
        : globalSize,
  }
}
