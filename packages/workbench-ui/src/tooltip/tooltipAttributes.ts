/*---------------------------------------------------------------------------------------------
 *  Tooltip host attributes and text resolution shared by the pointer path
 *  (`TooltipProvider`) and the keyboard path (Vim `K` on list rows). Keeping the
 *  attribute names here avoids the two paths drifting on what a tooltip host is.
 *--------------------------------------------------------------------------------------------*/

import { isElementLike } from '../dom/domRealm.js'

export const TOOLTIP_ATTRIBUTE = 'data-tooltip'

/**
 * Optional companion to {@link TOOLTIP_ATTRIBUTE}: when the hovered element also
 * carries `data-tooltip-command="<commandId>"` and the host injected a shortcut
 * resolver, the command's effective keybinding is appended to the text.
 */
export const TOOLTIP_COMMAND_ATTRIBUTE = 'data-tooltip-command'

/**
 * Marks the element inside a row whose tooltip represents the row. Commit graph
 * rows carry several tooltip hosts (ref badges, overflow button, message); the
 * keyboard path would otherwise surface the first badge instead of the message.
 */
export const TOOLTIP_PRIMARY_ATTRIBUTE = 'data-tooltip-primary'

/** Where a native `title` is stashed while the themed tooltip stands in for it. */
export const NATIVE_TITLE_STASH = 'data-tooltip-native-title'

export const TOOLTIP_HOST_SELECTOR = `[${TOOLTIP_ATTRIBUTE}],[${NATIVE_TITLE_STASH}],[title]`

/** Elements whose `title` carries semantics the tooltip must not stand in for
 *  (an iframe's title names the frame for assistive tech). */
const NATIVE_TITLE_EXCLUDED_TAGS = new Set(['IFRAME', 'WEBVIEW'])

/** Suppress the OS-native tooltip by moving `title` aside; the stash attribute
 *  keeps the element matching future `closest` lookups for the same hover. */
export function claimNativeTitle(el: Element): void {
  if (NATIVE_TITLE_EXCLUDED_TAGS.has(el.tagName)) return
  const title = el.getAttribute('title')
  if (title === null || el.hasAttribute(NATIVE_TITLE_STASH)) return
  el.setAttribute(NATIVE_TITLE_STASH, title)
  el.removeAttribute('title')
}

export function restoreNativeTitle(el: Element): void {
  const stashed = el.getAttribute(NATIVE_TITLE_STASH)
  if (stashed === null) return
  el.removeAttribute(NATIVE_TITLE_STASH)
  el.setAttribute('title', stashed)
}

/**
 * Resolved tooltip text for `el`: `data-tooltip`, the stashed native title, or
 * the live native title (iframe/webview excluded). Callers that want the native
 * bubble suppressed must call {@link claimNativeTitle} first.
 */
export function tooltipTextFrom(
  el: Element,
  resolveShortcut?: (commandId: string) => string | undefined,
): string {
  let text = (
    el.getAttribute(TOOLTIP_ATTRIBUTE) ??
    el.getAttribute(NATIVE_TITLE_STASH) ??
    (NATIVE_TITLE_EXCLUDED_TAGS.has(el.tagName) ? null : el.getAttribute('title')) ??
    ''
  ).trim()
  if (text && resolveShortcut) {
    const commandId = el.getAttribute(TOOLTIP_COMMAND_ATTRIBUTE)
    const shortcut = commandId ? resolveShortcut(commandId) : undefined
    if (shortcut) text = `${text} (${shortcut})`
  }
  return text
}

function hasTooltipText(el: Element): boolean {
  return tooltipTextFrom(el) !== ''
}

/**
 * The element inside `row` whose tooltip the keyboard path should show.
 * Priority: an explicit `data-tooltip-primary` host, the row itself, then the
 * first descendant with a usable tooltip. Returns null when the row has none.
 */
export function rowTooltipTarget(row: Element | null | undefined): Element | null {
  if (!isElementLike(row)) return null
  const primary = row.hasAttribute(TOOLTIP_PRIMARY_ATTRIBUTE)
    ? row
    : row.querySelector(`[${TOOLTIP_PRIMARY_ATTRIBUTE}]`)
  if (primary !== null && hasTooltipText(primary)) return primary
  if (hasTooltipText(row)) return row
  for (const el of Array.from(row.querySelectorAll(TOOLTIP_HOST_SELECTOR))) {
    if (NATIVE_TITLE_EXCLUDED_TAGS.has(el.tagName)) continue
    if (hasTooltipText(el)) return el
  }
  return null
}
