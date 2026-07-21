/**
 * Extension category set — shared by manifest validation, marketplace filtering,
 * and the extensions UI. VSCode uses a fixed enum tuned for a code editor; ours
 * is tuned for a game-content editor. `Other` is the fallback for anything that
 * doesn't fit. Kept in `extensions-common` so client + (future) backend agree.
 */
export const EXTENSION_CATEGORIES = [
  'Language Features',
  'Content Tools',
  'Data / Schema',
  'SCM / Git',
  'AI',
  'Themes',
  'Other',
] as const

export type ExtensionCategory = (typeof EXTENSION_CATEGORIES)[number]

/** Whether `value` is one of the known categories. */
export function isExtensionCategory(value: string): value is ExtensionCategory {
  return (EXTENSION_CATEGORIES as readonly string[]).includes(value)
}
