export const WORKBENCH_FONT_FAMILY_DEFAULT =
  "'Roboto', system-ui, -apple-system, 'Segoe UI', sans-serif"

export const EDITOR_FONT_FAMILY_DEFAULT = 'Consolas'

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
