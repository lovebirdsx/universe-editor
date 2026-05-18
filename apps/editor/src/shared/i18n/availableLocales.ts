import type { MessageMap } from '@universe-editor/platform'
import { EN_US_MESSAGES } from './messages/en-US.js'
import { ZH_CN_MESSAGES } from './messages/zh-CN.js'

export const DISPLAY_LANGUAGE_SETTING_KEY = 'workbench.language'
export const DEFAULT_LOCALE = 'en-US'

export const SUPPORTED_LOCALES = ['en-US', 'zh-CN'] as const

export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number]
export type DisplayLanguageSetting = SupportedLocale | 'auto'

export interface ILocaleOption {
  readonly value: DisplayLanguageSetting
  readonly label: string
  readonly description: string
}

const SUPPORTED_LOCALE_SET = new Set<string>(SUPPORTED_LOCALES)

export function isSupportedLocale(value: string): value is SupportedLocale {
  return SUPPORTED_LOCALE_SET.has(value)
}

export function normalizeLocale(input: string | undefined): SupportedLocale | undefined {
  if (!input) return undefined
  const lower = input.toLowerCase()
  if (lower.startsWith('zh')) return 'zh-CN'
  if (lower.startsWith('en')) return 'en-US'
  return undefined
}

export function resolveDisplayLanguage(
  requested: string | undefined,
  systemLocale: string | undefined,
): SupportedLocale {
  if (requested && requested !== 'auto') {
    const normalized = normalizeLocale(requested)
    if (normalized) return normalized
  }
  return normalizeLocale(systemLocale) ?? DEFAULT_LOCALE
}

export function getLocaleMessages(locale: SupportedLocale): MessageMap {
  if (locale === 'zh-CN') return ZH_CN_MESSAGES
  return EN_US_MESSAGES
}
