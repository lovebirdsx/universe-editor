/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  useGitGraphAutoRefresh — SCM-driven background reload, gated on editor visibility.
 *
 *  The Git Graph's auto-refresh reacts to every `git status` change mirrored by
 *  the SCM service; one revalidate spawns ~6-7 git sub-processes in the extension
 *  host. When the graph is not actually visible (its tab backgrounded, its group
 *  inactive, or the window unfocused) those refreshes are pure waste — and they
 *  multiply across windows. Instead of refreshing, a hidden graph marks itself
 *  stale and revalidates exactly once when it becomes visible again.
 *--------------------------------------------------------------------------------------------*/

import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react'
import {
  IEditorGroupsService,
  autorun,
  markAsSingleton,
  type IDisposable,
  type IEditorInput,
} from '@universe-editor/platform'
import { IScmService } from '../../services/extensions/ScmService.js'
import { useEditorGroup } from '../editor/EditorGroupContext.js'
import { useOptionalService } from '../useService.js'
import { useWindowFocused } from '../useWindowFocused.js'

/** Whether this graph editor is currently visible: its tab is the active editor
 *  of an active group AND the window is focused. */
export function useGitGraphEditorVisible(input: IEditorInput): boolean {
  const group = useEditorGroup()
  const groupsService = useOptionalService(IEditorGroupsService)
  const windowFocused = useWindowFocused()

  const subscribe = useCallback(
    (onChange: () => void) => {
      const disposables: IDisposable[] = []
      if (group) disposables.push(markAsSingleton(group.onDidActiveEditorChange(onChange)))
      if (groupsService) {
        disposables.push(markAsSingleton(groupsService.onDidActiveGroupChange(onChange)))
      }
      return () => {
        for (const d of disposables) d.dispose()
      }
    },
    [group, groupsService],
  )

  const getSnapshot = useCallback((): boolean => {
    // No editor-group context (unit tests render the editor bare): assume active
    // so auto-refresh keeps its historical always-on behaviour.
    if (!group) return true
    const isActiveEditor = group.activeEditor === input
    const isActiveGroup = groupsService ? groupsService.activeGroup === group : group.isActive
    return isActiveEditor && isActiveGroup
  }, [group, groupsService, input])

  const active = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  return active && windowFocused
}

/** Debounced-refresh state machine. Visibility gating lives here so it can be
 *  unit-tested without rendering the graph. */
export class AutoRefreshGate {
  private _timer: ReturnType<typeof setTimeout> | undefined
  private _stale = false
  private _visible: boolean

  constructor(
    private readonly _refresh: () => void,
    private readonly _debounce: number,
    initialVisible: boolean,
    private readonly _debug?: (message: string) => void,
  ) {
    this._visible = initialVisible
  }

  /** An external (SCM) change arrived. Visible → debounce a refresh; hidden →
   *  mark stale so the pending refresh collapses to one on re-show. */
  onExternalChange(): void {
    if (this._visible) {
      this._schedule()
    } else {
      this._stale = true
      this._debug?.('git graph hidden: auto-refresh marked stale')
    }
  }

  /** Visibility flipped. Coming back with stale data refreshes exactly once. */
  setVisible(visible: boolean): void {
    if (visible === this._visible) return
    this._visible = visible
    if (visible && this._stale) {
      this._stale = false
      this._debug?.('git graph visible again: revalidating stale graph')
      this._schedule()
    }
  }

  private _schedule(): void {
    if (this._timer) clearTimeout(this._timer)
    this._timer = setTimeout(() => {
      this._timer = undefined
      this._refresh()
    }, this._debounce)
  }

  dispose(): void {
    if (this._timer) clearTimeout(this._timer)
    this._timer = undefined
  }
}

export function useGitGraphAutoRefresh(
  scm: IScmService,
  visible: boolean,
  revalidate: () => void,
  debounce: number,
  debug?: (message: string) => void,
): void {
  const visibleRef = useRef(visible)
  visibleRef.current = visible
  const revalidateRef = useRef(revalidate)
  revalidateRef.current = revalidate
  const debugRef = useRef(debug)
  debugRef.current = debug

  const createGate = useCallback(
    () =>
      new AutoRefreshGate(
        () => revalidateRef.current(),
        debounce,
        visibleRef.current,
        (message) => debugRef.current?.(message),
      ),
    [debounce],
  )

  const gateRef = useRef<AutoRefreshGate | null>(null)
  if (gateRef.current === null) gateRef.current = createGate()

  // React to visibility transitions. Also re-creates the gate when a StrictMode
  // dry-run cleanup disposed + nulled it before this effect re-ran.
  useEffect(() => {
    if (gateRef.current === null) gateRef.current = createGate()
    gateRef.current.setVisible(visible)
  }, [visible, createGate])

  // Observe SCM changes and own the autorun + the gate's timer cleanup.
  useEffect(() => {
    if (gateRef.current === null) gateRef.current = createGate()
    const gate = gateRef.current
    let first = true
    const disposable = markAsSingleton(
      autorun((r) => {
        for (const sc of scm.sourceControls.read(r)) {
          sc.count.read(r)
          for (const group of sc.groups.read(r)) group.resources.read(r)
        }
        if (first) {
          first = false
          return
        }
        gate.onExternalChange()
      }),
    )
    return () => {
      disposable.dispose()
      gate.dispose()
      gateRef.current = null
    }
  }, [scm, createGate])
}
