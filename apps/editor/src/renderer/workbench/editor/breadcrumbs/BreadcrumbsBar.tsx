/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Breadcrumbs bar: file path + symbol path above a FileEditor, with VSCode-style
 *  roving focus, anchored file/symbol pickers and keyboard commands. Each editor
 *  group owns one bar and reads only its own outline scope.
 *--------------------------------------------------------------------------------------------*/

import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FocusEvent as ReactFocusEvent,
  type MouseEvent as ReactMouseEvent,
} from 'react'
import { ChevronRight } from 'lucide-react'
import {
  IContextKeyService,
  IEditorResolverService,
  IUriIdentityService,
  IWorkspaceService,
  localize,
  URI,
  type EditorInput,
} from '@universe-editor/platform'
import { isElementLike } from '@universe-editor/workbench-ui'
import { useObservable, useOptionalService, useService } from '../../useService.js'
import {
  IOutlineService,
  type OutlineViewState,
} from '../../../services/languageFeatures/OutlineService.js'
import {
  IBreadcrumbsService,
  type IBreadcrumbsController,
} from '../../../services/breadcrumbs/BreadcrumbsService.js'
import {
  buildBreadcrumbEntries,
  buildFileBreadcrumbSegments,
  buildSymbolBreadcrumbSegments,
  type BreadcrumbEntry,
  type FileBreadcrumbSegment,
} from '../../../services/breadcrumbs/breadcrumbsModel.js'
import { focusEditorInput } from '../../../services/editor/editorFocus.js'
import { useEditorGroup } from '../EditorGroupContext.js'
import { FileIcon } from '../../files/fileIconTheme.js'
import { SymbolIcon } from '../../symbols/symbolIcon.js'
import { useBreadcrumbsConfig } from './useBreadcrumbsConfig.js'
import {
  BREADCRUMB_PICKER_ATTRIBUTE,
  type BreadcrumbPickerAnchor,
} from './breadcrumbPickerLayout.js'
import { resolveFilePickerRoot } from './filePickerModel.js'
import { createSymbolPickerSnapshot, type SymbolPickerSnapshot } from './symbolPickerModel.js'
import { FileBreadcrumbPicker } from './FileBreadcrumbPicker.js'
import { SymbolBreadcrumbPicker } from './SymbolBreadcrumbPicker.js'
import type { OutlineNode } from '../../outline/outlineTree.js'
import styles from './BreadcrumbsBar.module.css'

interface PickerStateFile {
  readonly kind: 'file'
  readonly id: number
  readonly anchorIndex: number
  readonly anchor: BreadcrumbPickerAnchor
  readonly root: URI
  readonly focusResource: URI | undefined
}

interface PickerStateSymbol {
  readonly kind: 'symbol'
  readonly id: number
  readonly anchorIndex: number
  readonly anchor: BreadcrumbPickerAnchor
  readonly snapshot: SymbolPickerSnapshot
}

type PickerState = PickerStateFile | PickerStateSymbol

interface BreadcrumbControllerApi {
  focusLast(): void
  focusAndSelectLast(): void
  focusNext(): void
  focusPrevious(): void
  selectFocused(): void
  revealFocused(): void
  selectEditor(): void
  dismissPicker(): void
}

function toAnchorRect(element: HTMLElement): BreadcrumbPickerAnchor {
  const rect = element.getBoundingClientRect()
  return { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
}

export function BreadcrumbsBar({ input }: { input: EditorInput }) {
  const group = useEditorGroup()
  const outlineService = useService(IOutlineService)
  const scope = group ? outlineService.forGroup(group.id) : outlineService
  const outline = useObservable(scope.outline)
  const activeSymbol = useObservable(scope.activeSymbol)
  const config = useBreadcrumbsConfig()

  const uriIdentity = useOptionalService(IUriIdentityService)
  const workspaceService = useOptionalService(IWorkspaceService)
  const breadcrumbsService = useOptionalService(IBreadcrumbsService)
  const resolver = useOptionalService(IEditorResolverService)
  const contextKeyService = useOptionalService(IContextKeyService)

  // `current` is a plain getter; without subscribing, switching folders would
  // leave an outside-workspace path rendered as absolute until the next render.
  const [workspace, setWorkspace] = useState(() => workspaceService?.current ?? null)
  useEffect(() => {
    if (!workspaceService) return
    setWorkspace(workspaceService.current ?? null)
    const subscription = workspaceService.onDidChangeWorkspace((next) => {
      setWorkspace(next ?? null)
    })
    return () => subscription.dispose()
  }, [workspaceService])

  const resource = input.resource

  const fileSegments = useMemo<readonly FileBreadcrumbSegment[]>(() => {
    if (!resource) return []
    if (!uriIdentity) {
      return [{ kind: 'file', uri: resource, label: input.getName() }]
    }
    return buildFileBreadcrumbSegments(resource, workspace, uriIdentity, config.filePath)
  }, [resource, input, uriIdentity, workspace, config.filePath])

  const symbolSegments = useMemo(
    () => buildSymbolBreadcrumbSegments(outline, activeSymbol, config.symbolPath),
    [outline, activeSymbol, config.symbolPath],
  )

  const entries = useMemo(
    () => buildBreadcrumbEntries(fileSegments, symbolSegments),
    [fileSegments, symbolSegments],
  )
  const lastIndex = entries.length - 1

  const [focusedIndex, setFocusedIndex] = useState(-1)
  const [barHasFocus, setBarHasFocus] = useState(false)
  const [picker, setPicker] = useState<PickerState | null>(null)
  const pickerRef = useRef<PickerState | null>(null)
  pickerRef.current = picker
  const focusedIndexRef = useRef(focusedIndex)
  focusedIndexRef.current = focusedIndex
  const segmentRefs = useRef(new Map<number, HTMLElement>())
  const barRef = useRef<HTMLDivElement | null>(null)
  const suppressNextOpenRef = useRef<{ index: number; at: number } | null>(null)
  const pickerIdRef = useRef(0)
  const pickerBlurTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const symbolSessionRef = useRef<{ viewState: OutlineViewState | undefined } | null>(null)

  const clearPickerBlurTimer = useCallback(() => {
    if (pickerBlurTimerRef.current !== undefined) {
      clearTimeout(pickerBlurTimerRef.current)
      pickerBlurTimerRef.current = undefined
    }
  }, [])

  useEffect(() => clearPickerBlurTimer, [clearPickerBlurTimer])

  useEffect(() => {
    setFocusedIndex((previous) =>
      entries.length === 0 ? -1 : previous < 0 ? previous : Math.min(previous, entries.length - 1),
    )
  }, [entries.length])

  const restoreSymbolSession = useCallback(() => {
    const session = symbolSessionRef.current
    if (!session) return
    symbolSessionRef.current = null
    if (session.viewState) scope.restoreViewState(session.viewState)
  }, [scope])

  const controllerApiRef = useRef<BreadcrumbControllerApi | null>(null)
  const controller = useMemo<IBreadcrumbsController>(
    () => ({
      groupId: group?.id ?? -1,
      focusLast: () => controllerApiRef.current?.focusLast(),
      focusAndSelectLast: () => controllerApiRef.current?.focusAndSelectLast(),
      focusNext: () => controllerApiRef.current?.focusNext(),
      focusPrevious: () => controllerApiRef.current?.focusPrevious(),
      selectFocused: () => controllerApiRef.current?.selectFocused(),
      revealFocused: () => controllerApiRef.current?.revealFocused(),
      selectEditor: () => controllerApiRef.current?.selectEditor(),
      dismissPicker: () => controllerApiRef.current?.dismissPicker(),
    }),
    [group?.id],
  )

  const isWithinBreadcrumbs = useCallback((): boolean => {
    const doc = barRef.current?.ownerDocument
    const active = doc?.activeElement
    if (!doc || !active) return false
    if (barRef.current?.contains(active)) return true
    const element = active as Element
    return (
      typeof element.closest === 'function' &&
      element.closest(`[${BREADCRUMB_PICKER_ATTRIBUTE}]`) !== null
    )
  }, [])

  const closePicker = useCallback(
    (restorePreview: boolean) => {
      clearPickerBlurTimer()
      const current = pickerRef.current
      if (!current) return
      if (current.kind === 'symbol') {
        if (restorePreview) restoreSymbolSession()
        else symbolSessionRef.current = null
      }
      pickerRef.current = null
      setPicker(null)
      // Closing via Escape leaves focus on the removed portal node; give it back
      // to the anchor segment. A click elsewhere already moved focus by then.
      queueMicrotask(() => {
        const doc = barRef.current?.ownerDocument
        const active = doc?.activeElement
        if (!active || active === doc?.body) {
          const anchor = segmentRefs.current.get(current.anchorIndex)
          if (anchor?.isConnected) anchor.focus({ preventScroll: true })
        }
        if (!isWithinBreadcrumbs()) {
          setBarHasFocus(false)
          breadcrumbsService?.deactivate(controller)
        }
      })
    },
    [
      restoreSymbolSession,
      isWithinBreadcrumbs,
      breadcrumbsService,
      controller,
      clearPickerBlurTimer,
    ],
  )

  const restoreRef = useRef(restoreSymbolSession)
  restoreRef.current = restoreSymbolSession
  useEffect(() => () => restoreRef.current(), [])

  const openPickerAtIndex = useCallback(
    (index: number) => {
      const element = segmentRefs.current.get(index)
      const entry = entries[index]
      if (!element || !entry) return
      const current = pickerRef.current
      if (current?.anchorIndex === index) {
        closePicker(true)
        return
      }
      if (current) closePicker(true)
      const anchor = toAnchorRect(element)

      if (entry.kind === 'symbol') {
        const snapshot = createSymbolPickerSnapshot(outline, activeSymbol, config.symbolSortOrder)
        if (snapshot.roots.length === 0) return
        symbolSessionRef.current = { viewState: scope.captureViewState() }
        const next: PickerStateSymbol = {
          kind: 'symbol',
          id: pickerIdRef.current++,
          anchorIndex: index,
          anchor,
          snapshot,
        }
        pickerRef.current = next
        setPicker(next)
        return
      }

      if (!group) return
      const { root, focusResource } = resolveFilePickerRoot(entry.segment)
      const next: PickerStateFile = {
        kind: 'file',
        id: pickerIdRef.current++,
        anchorIndex: index,
        anchor,
        root,
        focusResource,
      }
      pickerRef.current = next
      setPicker(next)
    },
    [entries, closePicker, outline, activeSymbol, config.symbolSortOrder, scope, group],
  )

  const openFile = useCallback(
    (target: URI) => {
      if (!group || !resolver) return
      const input = resolver.createEditorInput(target)
      group.openEditor(input, { activate: true, pinned: true })
      requestAnimationFrame(() => {
        if (contextKeyService) focusEditorInput(input, contextKeyService, group.id)
      })
    },
    [group, resolver, contextKeyService],
  )

  const confirmSymbol = useCallback(
    (node: OutlineNode) => {
      restoreSymbolSession()
      closePicker(false)
      scope.revealSymbol(node.symbol)
    },
    [restoreSymbolSession, closePicker, scope],
  )

  const focusAt = useCallback(
    (index: number) => {
      if (entries.length === 0) return
      const clamped = Math.max(0, Math.min(entries.length - 1, index))
      setFocusedIndex(clamped)
      segmentRefs.current.get(clamped)?.focus({ preventScroll: true })
    },
    [entries.length],
  )

  useEffect(() => {
    if (entries.length === 0) return
    const container = barRef.current
    const element = segmentRefs.current.get(entries.length - 1)
    if (!container || !element) return
    scrollSegmentIntoView(container, element)
  }, [entries.length])

  useEffect(() => {
    if (!barHasFocus || focusedIndex < 0) return
    const container = barRef.current
    const element = segmentRefs.current.get(focusedIndex)
    if (!container || !element) return
    scrollSegmentIntoView(container, element)
  }, [focusedIndex, barHasFocus])

  useEffect(() => {
    const element = barRef.current
    if (!element) return
    const onWheel = (event: WheelEvent): void => {
      if (element.scrollWidth <= element.clientWidth) return
      if (event.deltaY === 0) return
      // Vertical wheel scrolls the bar horizontally when it overflows, matching
      // VSCode; only claim the gesture when there is something to scroll.
      element.scrollLeft += event.deltaY
      event.preventDefault()
    }
    element.addEventListener('wheel', onWheel, { passive: false })
    return () => element.removeEventListener('wheel', onWheel)
  }, [config.enabled])

  // Close the picker the moment the pointer lands outside it, before Monaco
  // handles the mousedown — an open symbol preview must be undone first, or the
  // restore would drag the viewport back after the user's click.
  useEffect(() => {
    if (!picker) return
    const doc = barRef.current?.ownerDocument ?? document
    const onMouseDown = (event: MouseEvent): void => {
      const target = event.target as Element | null
      if (!target || typeof target.closest !== 'function') return
      if (target.closest(`[${BREADCRUMB_PICKER_ATTRIBUTE}]`)) return
      if (barRef.current?.contains(target)) {
        const segment = target.closest('[data-breadcrumb-index]')
        if (
          segment &&
          Number(segment.getAttribute('data-breadcrumb-index')) === picker.anchorIndex
        ) {
          suppressNextOpenRef.current = { index: picker.anchorIndex, at: performance.now() }
        }
      }
      closePicker(true)
    }
    doc.addEventListener('mousedown', onMouseDown, true)
    return () => doc.removeEventListener('mousedown', onMouseDown, true)
  }, [picker, closePicker])

  const previousConfigRef = useRef({
    filePath: config.filePath,
    symbolPath: config.symbolPath,
    enabled: config.enabled,
  })
  useEffect(() => {
    const previous = previousConfigRef.current
    previousConfigRef.current = {
      filePath: config.filePath,
      symbolPath: config.symbolPath,
      enabled: config.enabled,
    }
    if (
      previous.filePath !== config.filePath ||
      previous.symbolPath !== config.symbolPath ||
      (previous.enabled && !config.enabled)
    ) {
      closePicker(true)
    }
  }, [config.filePath, config.symbolPath, config.enabled, closePicker])

  const previousWorkspaceRef = useRef(workspace)
  useEffect(() => {
    if (previousWorkspaceRef.current === workspace) return
    previousWorkspaceRef.current = workspace
    closePicker(true)
  }, [workspace, closePicker])

  const handleFocusCapture = useCallback(() => {
    setBarHasFocus(true)
    breadcrumbsService?.activate(controller)
  }, [breadcrumbsService, controller])

  // A picker lives in a portal, so focus moving into it blurs the bar without
  // focusing another bar segment. Keep `breadcrumbsActive` true while the
  // picker owns focus, otherwise closing it leaves the key in a dead state.
  const activateFromPicker = useCallback(() => {
    breadcrumbsService?.activate(controller)
  }, [breadcrumbsService, controller])

  // Tabbing (or programmatic focus) can leave the portal without a bar blur;
  // close the picker so `breadcrumbsActive` does not hijack keys elsewhere.
  // Focus moves onto a focusable row control (the twistie) in two steps: the
  // focusout is dispatched while `activeElement` is still <body>, so a microtask
  // would mistake it for leaving the portal. Check `relatedTarget` synchronously
  // and defer the fallback read to a timer, like installDocumentFocusReconcile.
  const handlePickerBlur = useCallback(
    (event: ReactFocusEvent<HTMLDivElement>) => {
      const next = event.relatedTarget
      if (
        isElementLike(next) &&
        (event.currentTarget.contains(next) || barRef.current?.contains(next))
      ) {
        clearPickerBlurTimer()
        return
      }
      clearPickerBlurTimer()
      const scheduledFor = pickerRef.current?.id
      pickerBlurTimerRef.current = setTimeout(() => {
        pickerBlurTimerRef.current = undefined
        if (pickerRef.current?.id !== scheduledFor) return
        if (isWithinBreadcrumbs()) return
        closePicker(true)
      }, 0)
    },
    [clearPickerBlurTimer, isWithinBreadcrumbs, closePicker],
  )

  const handleBlurCapture = useCallback(() => {
    queueMicrotask(() => {
      if (isWithinBreadcrumbs()) return
      setBarHasFocus(false)
      breadcrumbsService?.deactivate(controller)
    })
  }, [breadcrumbsService, controller, isWithinBreadcrumbs])

  const handleMouseDown = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      if (event.button !== 0 || !group || group.isActive) return
      // The group's own mousedown handler activates it and its activation effect
      // focuses Monaco; preserve focus so the breadcrumb click is not stolen.
      group.preserveFocusOnActivation?.(true)
      setTimeout(() => group.preserveFocusOnActivation?.(false), 0)
    },
    [group],
  )

  useEffect(() => {
    if (!breadcrumbsService || !group || !config.enabled) return
    const registration = breadcrumbsService.register(group.id, controller)
    return () => registration.dispose()
  }, [breadcrumbsService, group, config.enabled, controller])

  controllerApiRef.current = {
    focusLast: () => {
      focusAt(lastIndex)
    },
    focusAndSelectLast: () => {
      if (lastIndex < 0) return
      focusAt(lastIndex)
      openPickerAtIndex(lastIndex)
    },
    focusNext: () => {
      focusAt(focusedIndexRef.current < 0 ? lastIndex : focusedIndexRef.current + 1)
    },
    focusPrevious: () => {
      focusAt(focusedIndexRef.current < 0 ? lastIndex : focusedIndexRef.current - 1)
    },
    selectFocused: () => {
      const index = focusedIndexRef.current >= 0 ? focusedIndexRef.current : lastIndex
      if (index < 0) return
      focusAt(index)
      openPickerAtIndex(index)
    },
    revealFocused: () => {
      const index = focusedIndexRef.current
      const entry: BreadcrumbEntry | undefined = entries[index]
      if (!entry) return
      if (entry.kind === 'symbol') {
        closePicker(true)
        scope.revealSymbol(entry.segment.symbol)
        return
      }
      if (entry.segment.kind === 'file') {
        closePicker(true)
        openFile(entry.segment.uri)
        return
      }
      openPickerAtIndex(index)
    },
    selectEditor: () => {
      closePicker(true)
      const activeEditor = group?.activeEditor
      if (activeEditor && contextKeyService && group) {
        focusEditorInput(activeEditor, contextKeyService, group.id)
      } else {
        group?.focus()
      }
      setBarHasFocus(false)
      breadcrumbsService?.deactivate(controller)
    },
    dismissPicker: () => {
      closePicker(true)
      breadcrumbsService?.deactivate(controller)
    },
  }

  if (!config.enabled) return null

  return (
    <>
      <div
        ref={barRef}
        className={styles['bar']}
        data-testid="editor-breadcrumbs"
        role="toolbar"
        aria-label={localize('breadcrumbs.ariaLabel', 'Breadcrumbs')}
        onMouseDown={handleMouseDown}
        onFocusCapture={handleFocusCapture}
        onBlurCapture={handleBlurCapture}
      >
        {entries.map((entry) => (
          <Fragment key={`${entry.kind}:${entry.index}`}>
            {entry.index > 0 && (
              <span className={styles['separator']} aria-hidden="true">
                <ChevronRight size={14} />
              </span>
            )}
            <div
              ref={(element) => {
                if (element) segmentRefs.current.set(entry.index, element)
                else segmentRefs.current.delete(entry.index)
              }}
              className={styles['segment']}
              role="button"
              tabIndex={
                focusedIndex === entry.index || (focusedIndex < 0 && entry.index === lastIndex)
                  ? 0
                  : -1
              }
              aria-label={entry.segment.label}
              data-breadcrumb-index={entry.index}
              data-breadcrumb-focused={
                barHasFocus && focusedIndex === entry.index ? 'true' : undefined
              }
              data-breadcrumb-active={entry.index === lastIndex ? 'true' : undefined}
              onFocus={() => setFocusedIndex(entry.index)}
              onMouseDown={(event) => {
                if (event.button === 0) event.currentTarget.focus({ preventScroll: true })
              }}
              onClick={() => {
                const suppress = suppressNextOpenRef.current
                suppressNextOpenRef.current = null
                if (
                  suppress &&
                  suppress.index === entry.index &&
                  performance.now() - suppress.at < 500
                ) {
                  return
                }
                openPickerAtIndex(entry.index)
              }}
            >
              {config.icons && entry.kind === 'file' && entry.segment.kind === 'file' && (
                <span className={styles['icon']} aria-hidden="true">
                  <FileIcon
                    resource={entry.segment.uri}
                    isDirectory={false}
                    languageId={outline?.languageId}
                    size={14}
                  />
                </span>
              )}
              {config.icons && entry.kind === 'symbol' && (
                <span className={styles['icon']} aria-hidden="true">
                  <SymbolIcon
                    kind={entry.segment.symbol.kind}
                    languageId={outline?.languageId}
                    size={14}
                  />
                </span>
              )}
              <span className={styles['label']}>{entry.segment.label}</span>
            </div>
          </Fragment>
        ))}
      </div>
      {picker?.kind === 'file' && (
        <FileBreadcrumbPicker
          key={picker.id}
          anchor={picker.anchor}
          root={picker.root}
          focusResource={picker.focusResource}
          onFocus={activateFromPicker}
          onBlur={handlePickerBlur}
          onClose={() => closePicker(true)}
        />
      )}
      {picker?.kind === 'symbol' && (
        <SymbolBreadcrumbPicker
          key={picker.id}
          anchor={picker.anchor}
          snapshot={picker.snapshot}
          scope={scope}
          onFocus={activateFromPicker}
          onBlur={handlePickerBlur}
          onConfirm={confirmSymbol}
          onClose={() => closePicker(true)}
        />
      )}
    </>
  )
}

function scrollSegmentIntoView(container: HTMLElement, element: HTMLElement): void {
  const containerRect = container.getBoundingClientRect()
  const elementRect = element.getBoundingClientRect()
  if (elementRect.left < containerRect.left) {
    container.scrollLeft -= containerRect.left - elementRect.left
  } else if (elementRect.right > containerRect.right) {
    container.scrollLeft += elementRect.right - containerRect.right
  }
}
