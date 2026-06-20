export type MessageValue = string

export type MessageMap = Readonly<Record<string, MessageValue>>

/**
 * A localized string that also carries its original (English) form. Mirrors
 * VSCode's `ILocalizedString`: `value` is shown to the user, `original` is kept
 * so non-English UIs can still match against the English command title.
 */
export interface ILocalizedString {
  readonly value: string
  readonly original: string
}

export interface IConfigureNlsOptions {
  readonly locale: string
  readonly fallbackLocale?: string
  readonly messages?: MessageMap
  readonly fallbackMessages?: MessageMap
  readonly warnOnMissing?: boolean
}

interface NlsState {
  locale: string
  fallbackLocale: string
  messages: MessageMap
  fallbackMessages: MessageMap
  warnOnMissing: boolean
}

const EMPTY_MESSAGES: MessageMap = Object.freeze({})

let state: NlsState = {
  locale: 'en-US',
  fallbackLocale: 'en-US',
  messages: EMPTY_MESSAGES,
  fallbackMessages: EMPTY_MESSAGES,
  warnOnMissing: false,
}

function formatMessage(template: string, vars?: Record<string, unknown>): string {
  if (!vars) return template
  return template.replace(/\{([^}]+)\}/g, (match, rawKey) => {
    const key = String(rawKey).trim()
    const value = vars[key]
    return value === undefined ? match : String(value)
  })
}

export function configureNls(options: IConfigureNlsOptions): void {
  state = {
    locale: options.locale,
    fallbackLocale: options.fallbackLocale ?? options.locale,
    messages: options.messages ?? EMPTY_MESSAGES,
    fallbackMessages: options.fallbackMessages ?? options.messages ?? EMPTY_MESSAGES,
    warnOnMissing: options.warnOnMissing ?? false,
  }
}

export function getCurrentLocale(): string {
  return state.locale
}

export function localize(
  key: string,
  defaultMessage: string,
  vars?: Record<string, unknown>,
): string {
  const translated = state.messages[key] ?? state.fallbackMessages[key]
  const template = translated ?? defaultMessage

  if (
    translated === undefined &&
    typeof console !== 'undefined' &&
    key &&
    state.warnOnMissing &&
    (Object.keys(state.messages).length > 0 || Object.keys(state.fallbackMessages).length > 0)
  ) {
    console.warn(
      `[nls] Missing translation for "${key}" in locale "${state.locale}" (fallback "${state.fallbackLocale}")`,
    )
  }

  return formatMessage(template, vars)
}

/**
 * Like {@link localize}, but returns both the localized `value` and the
 * `original` (English) form. Use for command/menu titles so the command palette
 * can match the English title even under a non-English display language.
 */
export function localize2(
  key: string,
  defaultMessage: string,
  vars?: Record<string, unknown>,
): ILocalizedString {
  return {
    value: localize(key, defaultMessage, vars),
    original: formatMessage(defaultMessage, vars),
  }
}
