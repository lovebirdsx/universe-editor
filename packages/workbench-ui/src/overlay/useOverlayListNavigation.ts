/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  useOverlayListNavigation — keyboard navigation for a *transient* list overlay
 *  (a dropdown / picker popup): the popup-side sibling of useFlatListNavigation.
 *
 *  The two are deliberately separate models. A view list is a Tab stop the user
 *  lands in and later leaves — it seeds its first row, hands focus back on
 *  Shift+Tab, and owns the ContextMenu key. An overlay is opened *onto* a value,
 *  owns every key while it is up, and disappears the moment one is picked. What
 *  they share is index arithmetic: `resolveIndexNavigation` in listKeyboard.ts.
 *
 *  ARIA follows the house convention (see useFlatListNavigation): the container
 *  holds DOM focus and rows are marked with aria-selected / data-active. tabIndex
 *  is -1 rather than 0 because an overlay is never reached by Tab — the host
 *  focuses the container as it opens.
 *
 *  Escape is NOT handled in `onKeyDown`: AnchoredSurface already claims it on
 *  window capture, ahead of the workbench keybinding dispatcher, so a React
 *  onKeyDown never sees it. Hosts wire `onEscape` to AnchoredSurface's `onEscape`
 *  instead, where returning true peels one level and keeps the surface open.
 *--------------------------------------------------------------------------------------------*/

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
} from 'react'
import { resolveIndexNavigation } from '../list/listKeyboard.js'

/** Typeahead buffer lifetime — a pause longer than this starts a fresh query. */
const TYPEAHEAD_RESET_MS = 500

export interface IOverlayListActivateOptions {
  /** True for Space (a toggle / preview gesture), false for Enter and clicks. */
  readonly preview: boolean
}

export interface IUseOverlayListNavigationOptions {
  readonly count: number
  /**
   * Row highlighted as the overlay opens — normally the current value, so the
   * first arrow press steps *away* from it instead of from the top.
   */
  readonly initialIndex: number
  readonly onActivate: (index: number, opts: IOverlayListActivateOptions) => void
  /** Per-index text for letter jumps. Omit to disable typeahead entirely. */
  readonly getTypeaheadText?: ((index: number) => string) | undefined
  /** Alt+<digit> while the overlay is up — jump straight to another config entry. */
  readonly onAltDigit?: ((digit: number) => void) | undefined
  /**
   * ArrowUp on the first row / ArrowDown on the last. Only consulted when
   * `wrap` is off, where the key would otherwise do nothing — this is how a
   * nested region (an overflow row's expanded body) hands the cursor back to
   * the list that hosts it.
   */
  readonly onExitUp?: (() => void) | undefined
  readonly onExitDown?: (() => void) | undefined
  /** Wraps ArrowUp / ArrowDown past the ends. Defaults to true, as pickers do. */
  readonly wrap?: boolean | undefined
  /**
   * Whether attaching the container takes focus. Defaults to true — an overlay
   * opens onto a value, so the arrows must work without a click first. A list
   * that mounts alongside a nested region which owns the focus (the overflow
   * panel's rows when one of them is already expanded) opts out, because host
   * refs fire child-first and would otherwise yank focus back out of that region.
   */
  readonly autoFocus?: boolean | undefined
  readonly ariaLabel?: string | undefined
}

export interface IOverlayListContainerProps {
  readonly role: 'listbox'
  readonly 'aria-label': string | undefined
  readonly tabIndex: -1
  readonly onKeyDown: (e: KeyboardEvent) => void
  readonly onMouseDown: () => void
}

export interface IOverlayListItemProps {
  readonly role: 'option'
  readonly 'aria-selected': boolean
  readonly 'data-active': boolean
  readonly onMouseDown: (e: MouseEvent) => void
}

export interface IOverlayListNavigation {
  readonly activeIndex: number
  readonly setActiveIndex: (index: number) => void
  /** Attach to the popup's list element. Focuses it on mount. */
  readonly containerRef: (node: HTMLElement | null) => void
  readonly containerProps: IOverlayListContainerProps
  /** Identity + ARIA + default click. Spread first, then your own overrides. */
  readonly getItemProps: (index: number) => IOverlayListItemProps
}

const clampIndex = (index: number, count: number): number =>
  count <= 0 ? -1 : Math.max(0, Math.min(count - 1, index))

// `resolveIndexNavigation` clamps, so "did not move" at an end means the key hit
// the boundary. Turning that into the opposite end is the only thing `wrap` adds.
function applyWrap(key: string, from: number, next: number, count: number): number {
  if (count <= 1 || next !== from) return next
  if (key === 'ArrowDown') return 0
  if (key === 'ArrowUp') return count - 1
  return next
}

export function useOverlayListNavigation(
  options: IUseOverlayListNavigationOptions,
): IOverlayListNavigation {
  const { count, initialIndex } = options
  const [activeIndex, setActiveIndex] = useState(() => clampIndex(initialIndex, count))
  const containerElRef = useRef<HTMLElement | null>(null)
  const typeaheadRef = useRef({ buffer: '', timer: 0 })

  // Everything the handlers read goes through a ref so `onKeyDown` keeps a stable
  // identity: hosts spread containerProps onto the popup element, and a fresh
  // handler on every arrow press would re-render the whole list.
  const optionsRef = useRef(options)
  optionsRef.current = options

  const activeIndexRef = useRef(activeIndex)
  activeIndexRef.current = activeIndex

  // The host reuses one element position when the overlay swaps to a different
  // list (Alt+<digit> between config entries), so a fresh mount is not guaranteed
  // — re-seed whenever the incoming value actually changes.
  const seededRef = useRef(initialIndex)
  useEffect(() => {
    if (seededRef.current === initialIndex) return
    seededRef.current = initialIndex
    setActiveIndex(clampIndex(initialIndex, count))
  }, [initialIndex, count])

  useEffect(() => {
    setActiveIndex((i) => {
      // Mounted with an empty list (the overflow panel's rows are packed in by a
      // measurement that lands after the first render), so the cursor was
      // clamped to -1 and nothing would ever highlight it — not even the first
      // arrow press, and Enter stays a dead key. Seed it now that rows exist.
      if (i < 0) return clampIndex(seededRef.current, count)
      // A shorter list arriving under a live cursor must not leave it past the end.
      return i >= count ? clampIndex(i, count) : i
    })
  }, [count])

  const containerRef = useCallback((node: HTMLElement | null) => {
    containerElRef.current = node
    // preventScroll — the popup may have scrolled.
    if (optionsRef.current.autoFocus === false) return
    node?.focus({ preventScroll: true })
  }, [])

  const runTypeahead = useCallback((char: string): boolean => {
    const { count: total, getTypeaheadText } = optionsRef.current
    if (!getTypeaheadText || total <= 0) return false
    const state = typeaheadRef.current
    window.clearTimeout(state.timer)
    state.buffer += char
    state.timer = window.setTimeout(() => {
      state.buffer = ''
    }, TYPEAHEAD_RESET_MS)
    // A single letter steps to the *next* match so repeats cycle the options; a
    // longer query is a fresh prefix and searches from the top.
    const first = state.buffer.length === 1
    const start = first ? activeIndexRef.current + 1 : 0
    const query = state.buffer.toLowerCase()
    for (let i = 0; i < total; i++) {
      const index = (((start + i) % total) + total) % total
      if ((getTypeaheadText(index) ?? '').toLowerCase().startsWith(query)) {
        setActiveIndex(index)
        break
      }
    }
    // Consumed even when nothing matched: a stray letter must not fall through
    // to the host (or to the workbench) as a command.
    return true
  }, [])

  const onKeyDown = useCallback(
    (e: KeyboardEvent) => {
      const { count: total, onActivate, onAltDigit, wrap = true } = optionsRef.current
      // IME composition owns every keystroke until it commits. Read through
      // `nativeEvent`: React's synthetic KeyboardEvent does not surface
      // `isComposing`, so `e.isComposing` here would always be undefined and the
      // guard would be dead code. keyCode 229 is Chromium's legacy composition
      // sentinel, checked the same way as the workbench dispatcher.
      if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return

      // Alt+<digit> jumps straight to another entry of the host's entry list.
      // Read from `code` so macOS — where Option+1 types `¡` into `key` — behaves
      // the same as Windows. Only 1..8: that is the range the host binds, and
      // matching more would let a key that does nothing while the overlay is
      // closed do something only while it is up.
      if (e.altKey && !e.ctrlKey && !e.metaKey) {
        const digit = /^Digit([1-8])$/.exec(e.code)?.[1]
        if (digit !== undefined && onAltDigit) {
          e.preventDefault()
          e.stopPropagation()
          onAltDigit(Number(digit))
        }
        return
      }
      // Other modifier combos belong to the workbench / the host.
      if (e.ctrlKey || e.metaKey) return
      if (total <= 0) return

      const next = resolveIndexNavigation(e.key, { index: activeIndexRef.current, count: total })
      if (next !== undefined) {
        e.preventDefault()
        e.stopPropagation()
        const target = wrap ? applyWrap(e.key, activeIndexRef.current, next, total) : next
        // Clamped onto the row we are already on = the key hit an end. With
        // wrapping off that is where a nested region hands the cursor back.
        if (!wrap && target === activeIndexRef.current) {
          if (e.key === 'ArrowUp') optionsRef.current.onExitUp?.()
          else if (e.key === 'ArrowDown') optionsRef.current.onExitDown?.()
          return
        }
        setActiveIndex(target)
        return
      }

      if (e.key === 'Enter' || e.key === ' ') {
        const index = activeIndexRef.current
        if (index < 0 || index >= total) return
        e.preventDefault()
        e.stopPropagation()
        onActivate(index, { preview: e.key === ' ' })
        return
      }

      // Printable characters feed typeahead. Shift is allowed through — capital
      // letters are part of the query; Ctrl / Alt / Meta were handled above.
      if (e.key.length === 1 && runTypeahead(e.key)) {
        e.preventDefault()
        e.stopPropagation()
      }
    },
    [runTypeahead],
  )

  const onContainerMouseDown = useCallback(() => {
    const el = containerElRef.current
    if (el && el.ownerDocument.activeElement !== el) el.focus({ preventScroll: true })
  }, [])

  const getItemProps = useCallback(
    (index: number): IOverlayListItemProps => ({
      role: 'option',
      'aria-selected': index === activeIndex,
      'data-active': index === activeIndex,
      onMouseDown: (e: MouseEvent) => {
        // Keep focus where it is: the click is about to close the overlay, and
        // letting the browser move focus first would blur the popup through the
        // host's dismissal path before the pick lands.
        e.preventDefault()
        optionsRef.current.onActivate(index, { preview: false })
      },
    }),
    [activeIndex],
  )

  return {
    activeIndex,
    setActiveIndex,
    containerRef,
    containerProps: {
      role: 'listbox',
      'aria-label': options.ariaLabel,
      tabIndex: -1,
      onKeyDown,
      onMouseDown: onContainerMouseDown,
    },
    getItemProps,
  }
}
