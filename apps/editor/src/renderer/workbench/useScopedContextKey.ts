/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  useScopedContextKey — owns a scoped ContextKeyService seeded from a plain
 *  overrides object, for menus whose `when` clauses gate on the clicked row /
 *  tab / editor.
 *
 *  It exists because the obvious spelling is wrong in two ways that both fail
 *  silently. `ScopedContextKeyService.dispose()` only clears its keys: reads
 *  then fall through to the parent, so a disposed service answers every lookup
 *  with `undefined` instead of throwing, and every `when` clause quietly turns
 *  false. And `useMemo` + a cleanup that disposes hands StrictMode's dev-only
 *  mount→unmount→mount dry run exactly that: the memoized service is emptied
 *  before the real mount, and any later re-render re-resolves the menu against
 *  it — the entries vanish, or the whole menu unmounts. Production never shows
 *  this, so it survives e2e.
 *
 *  Not every scoped service belongs here. Ones whose keys are rewritten over
 *  time by effects (useEditorGroupScopedContextKey, useViewScopedContextKey)
 *  are a different shape, and ones created imperatively inside an event handler
 *  and disposed on close (TimelineView, ExtensionTreeView) never touch the
 *  React lifecycle that breaks.
 *--------------------------------------------------------------------------------------------*/

import { useEffect, useReducer, useRef } from 'react'
import {
  markAsSingleton,
  type IContextKeyService,
  type IScopedContextKeyService,
} from '@universe-editor/platform'

function sameOverrides(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const keys = Object.keys(a)
  if (keys.length !== Object.keys(b).length) return false
  return keys.every((k) => Object.is(a[k], b[k]))
}

/**
 * Compares `overrides` by content, so callers pass an inline object literal and
 * get one service for as long as the values hold — no `useMemo` contract to
 * remember, and no rebuild on every parent render.
 *
 * `parent` may be undefined for callers whose context service is optional
 * (Explorer renders without one in tests); there is then nothing to scope and
 * the result is undefined as well.
 */
export function useScopedContextKey(
  parent: IContextKeyService,
  overrides: Record<string, unknown>,
): IScopedContextKeyService
export function useScopedContextKey(
  parent: IContextKeyService | undefined,
  overrides: Record<string, unknown>,
): IScopedContextKeyService | undefined
export function useScopedContextKey(
  parent: IContextKeyService | undefined,
  overrides: Record<string, unknown>,
): IScopedContextKeyService | undefined {
  const ref = useRef<{
    service: IScopedContextKeyService
    parent: IContextKeyService
    overrides: Record<string, unknown>
  } | null>(null)
  const [, forceUpdate] = useReducer((n: number) => n + 1, 0)

  const current = ref.current
  if (parent === undefined) {
    current?.service.dispose()
    ref.current = null
  } else if (
    current === null ||
    current.parent !== parent ||
    !sameOverrides(current.overrides, overrides)
  ) {
    // beforeunload (reload / Restart Editor) fires before React teardown, so
    // mark singleton to keep the leak tracker quiet.
    const service = markAsSingleton(parent.createScoped(overrides))
    current?.service.dispose()
    ref.current = { service, parent, overrides }
  }

  useEffect(() => {
    // Reached with a null ref only after StrictMode's dry run disposed the
    // throwaway instance; rebuild and re-render so consumers (which read the
    // service during render) hold the live one.
    if (parent !== undefined && ref.current === null) {
      ref.current = {
        service: markAsSingleton(parent.createScoped(overrides)),
        parent,
        overrides,
      }
      forceUpdate()
    }
    return () => {
      ref.current?.service.dispose()
      ref.current = null
    }
    // Identity changes are handled during render above; this effect only owns
    // the mount/unmount boundary.
  }, [])

  return ref.current?.service
}
