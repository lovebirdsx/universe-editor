import { MOBILE_PAIR_PAGE_PATH } from '@universe-editor/mobile-protocol'

export type Route =
  | { readonly name: 'pair' }
  | { readonly name: 'inbox' }
  | { readonly name: 'session'; readonly sessionKey: string }
  | { readonly name: 'new-session' }
  | { readonly name: 'sessions' }

export const SESSION_ROUTE_PREFIX = '/s/'
export const NEW_SESSION_PATH = '/new'
export const SESSIONS_PATH = '/sessions'

export function sessionPath(sessionKey: string): string {
  return `${SESSION_ROUTE_PREFIX}${encodeURIComponent(sessionKey)}`
}

export function readRoute(pathname: string): Route {
  if (pathname === MOBILE_PAIR_PAGE_PATH) return { name: 'pair' }
  if (pathname === NEW_SESSION_PATH) return { name: 'new-session' }
  if (pathname === SESSIONS_PATH) return { name: 'sessions' }
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
 * `pushState` so the browser back button returns to the previous page. The
 * depth marker lets the in-app back button tell an in-app entry apart from a
 * cold load of `/s/…` (where `history.back()` would leave the app).
 */
export function pushMobileRoute(
  path: string,
  history: Pick<History, 'pushState' | 'state'> = window.history,
): void {
  const state = history.state as { readonly depth?: unknown } | null
  const depth = (typeof state?.depth === 'number' ? state.depth : 0) + 1
  history.pushState({ mobile: true, depth }, '', path)
}

export function navigateToSession(
  sessionKey: string,
  history: Pick<History, 'pushState' | 'state'> = window.history,
): void {
  pushMobileRoute(sessionPath(sessionKey), history)
}

export function navigateToNewSession(
  history: Pick<History, 'pushState' | 'state'> = window.history,
): void {
  pushMobileRoute(NEW_SESSION_PATH, history)
}

export function navigateToSessions(
  history: Pick<History, 'pushState' | 'state'> = window.history,
): void {
  pushMobileRoute(SESSIONS_PATH, history)
}

export function navigateToInbox(
  history: Pick<History, 'pushState' | 'state'> = window.history,
): void {
  pushMobileRoute('/', history)
}

/** Back out of a non-inbox route, preserving the in-app history when possible. */
function leavePage(
  history: Pick<History, 'back' | 'replaceState' | 'state'> = window.history,
): void {
  const state = history.state as { readonly mobile?: unknown; readonly depth?: unknown } | null
  // Depth 1 means this entry was pushed from outside the app (cold load or a
  // notification that replaced the root entry); `back()` would leave the PWA.
  if (state?.mobile === true && typeof state.depth === 'number' && state.depth > 1) {
    history.back()
    return
  }
  history.replaceState(null, '', '/')
  window.dispatchEvent(new PopStateEvent('popstate'))
}

export function leaveSession(
  history: Pick<History, 'back' | 'replaceState' | 'state'> = window.history,
): void {
  leavePage(history)
}

export function leaveSessions(
  history: Pick<History, 'back' | 'replaceState' | 'state'> = window.history,
): void {
  leavePage(history)
}
