import { configureNls } from '@universe-editor/platform'
import { parse } from 'jsonc-parser'
import type { IUserDataFilesService } from '@universe-editor/platform'
import { UserDataFile } from '@universe-editor/platform'
import {
  DEFAULT_LOCALE,
  DISPLAY_LANGUAGE_SETTING_KEY,
  getLocaleMessages,
  resolveDisplayLanguage,
  setCurrentLocale,
  type SupportedLocale,
} from './availableLocales.js'

export interface IConfiguredLocale {
  readonly locale: SupportedLocale
  readonly requested: string | undefined
}

function parseLanguageSetting(text: string): string | undefined {
  if (text.trim() === '') return undefined
  const parsed = parse(text) as Record<string, unknown> | undefined
  const value = parsed?.[DISPLAY_LANGUAGE_SETTING_KEY]
  return typeof value === 'string' ? value : undefined
}

export function configureEditorNls(locale: SupportedLocale): SupportedLocale {
  configureNls({
    locale,
    fallbackLocale: DEFAULT_LOCALE,
    messages: getLocaleMessages(locale),
    fallbackMessages: getLocaleMessages(DEFAULT_LOCALE),
  })
  setCurrentLocale(locale)
  return locale
}

export async function initializeRendererNls(
  files: IUserDataFilesService,
  systemLocale: string | undefined,
): Promise<IConfiguredLocale> {
  const text = await files.read(UserDataFile.Settings)
  const requested = parseLanguageSetting(text)
  const locale = resolveDisplayLanguage(requested, systemLocale)
  configureEditorNls(locale)
  return { locale, requested }
}

export function initializeMainNls(
  settingsText: string,
  systemLocale: string | undefined,
): IConfiguredLocale {
  const requested = parseLanguageSetting(settingsText)
  const locale = resolveDisplayLanguage(requested, systemLocale)
  configureEditorNls(locale)
  return { locale, requested }
}
