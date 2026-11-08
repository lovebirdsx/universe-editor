import { MOBILE_PAIR_PAGE_PATH } from '@universe-editor/mobile-protocol'

export type Route =
  | { readonly name: 'pair' }
  | { readonly name: 'inbox' }
  | { readonly name: 'session'; readonly sessionKey: string }
  | { readonly name: 'new-session' }

export const SESSION_ROUTE_PREFIX = '/s/'
export const NEW_SESSION_PATH = '/new'

export function sessionPath(sessionKey: string): string {
  return `${SESSION_ROUTE_PREFIX}${encodeURIComponent(sessionKey)}`
}

export function readRoute(pathname: string): Route {
  if (pathname === MOBILE_PAIR_PAGE_PATH) return { name: 'pair' }
  if (pathname === NEW_SESSION_PATH) return { name: 'new-session' }
  if (pathname.startsWith(SESSION_ROUTE_PREFIX)) {
    const raw = pathname.slice(SESSION_ROUTE_PREFIX.length)
    if (raw !== '') {
      try {
        return { name: 'session', sessionKey: decodeURIComponent(raw) }
      } catch {
        return { name: 'inbox' }
      }
    }
  }
  return { name: 'inbox' }
}

/**
 * `pushState` so the browser back button returns to the inbox. The marker in
 * `history.state` lets the in-app back button tell an in-app entry apart from a
 * cold load of `/s/…` (where `history.back()` would leave the app).
 */
export function navigateToSession(
  sessionKey: string,
  history: Pick<History, 'pushState'> = window.history,
): void {
  history.pushState({ mobile: true }, '', sessionPath(sessionKey))
}

export function navigateToNewSession(history: Pick<History, 'pushState'> = window.history): void {
  history.pushState({ mobile: true }, '', NEW_SESSION_PATH)
}

export function navigateToInbox(history: Pick<History, 'pushState'> = window.history): void {
  history.pushState({ mobile: true }, '', '/')
}

export function leaveSession(
  history: Pick<History, 'back' | 'replaceState' | 'state'> = window.history,
): void {
  const state = history.state as { readonly mobile?: unknown } | null
  if (state?.mobile === true) {
    history.back()
    return
  }
  history.replaceState(null, '', '/')
  window.dispatchEvent(new PopStateEvent('popstate'))
}
