import { readStoredString, writeStoredString } from '../preferences.js'

export const SESSION_CLOSE_CONFIRM_STORAGE_KEY = 'universe.mobile.sessionCloseConfirm'
export const SESSION_REMOVE_CONFIRM_STORAGE_KEY = 'universe.mobile.sessionRemoveConfirm'

const CONFIRM_ASK = 'ask'
const CONFIRM_NEVER = 'never'

export function isSessionCloseConfirmEnabled(): boolean {
  return readStoredString(SESSION_CLOSE_CONFIRM_STORAGE_KEY) !== CONFIRM_NEVER
}

export function setSessionCloseConfirmEnabled(enabled: boolean): void {
  writeStoredString(SESSION_CLOSE_CONFIRM_STORAGE_KEY, enabled ? CONFIRM_ASK : CONFIRM_NEVER)
}

export function isSessionRemoveConfirmEnabled(): boolean {
  return readStoredString(SESSION_REMOVE_CONFIRM_STORAGE_KEY) !== CONFIRM_NEVER
}

export function setSessionRemoveConfirmEnabled(enabled: boolean): void {
  writeStoredString(SESSION_REMOVE_CONFIRM_STORAGE_KEY, enabled ? CONFIRM_ASK : CONFIRM_NEVER)
}

/** `situationNeedsConfirm` only says the scene warrants a prompt; the preference can suppress it. */
export function shouldConfirmSessionClose(situationNeedsConfirm: boolean): boolean {
  return situationNeedsConfirm && isSessionCloseConfirmEnabled()
}
