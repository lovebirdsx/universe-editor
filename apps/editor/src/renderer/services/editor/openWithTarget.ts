/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Target-aware opening shared by every built-in "open this document" gesture.
 *
 *  `default` is deliberately not implemented here: each call site keeps its own
 *  existing default path (usually `IEditorService.openEditor`, whose dedupe and
 *  preview rules differ per surface). These helpers only answer "side" and
 *  "newWindow", and return `handled: false` when the target could not be
 *  honoured so the caller can fall back to that default path.
 *
 *  Two invariants:
 *  - The same EditorInput instance never lands in two groups (closing one tab
 *    would dispose the other). Existing inputs are cloned (copy), moved, or
 *    rebuilt through a fresh factory.
 *  - `ensureSideGroup` runs at the open site, never before an await, so a
 *    failed open does not leave an orphan group behind.
 *--------------------------------------------------------------------------------------------*/

import {
  IEditorGroupsService,
  IInstantiationService,
  IEditorResolverService,
  IUriIdentityService,
  type EditorInput,
  type IEditorGroup,
  type URI,
} from '@universe-editor/platform'
import { IAuxiliaryEditorWindowService } from '../windows/auxiliaryEditorWindowService.js'
import { canCloneEditorInputForSplit, cloneEditorInputForSplit } from './cloneEditorInput.js'
import { openInLockAwareGroup } from './openInLockAwareGroup.js'
import { ensureSideGroup } from './openToSide.js'
import type { OpenTarget } from './openTarget.js'

export interface OpenTargetServices {
  readonly groups: IEditorGroupsService
  readonly aux: IAuxiliaryEditorWindowService
  readonly inst: IInstantiationService
  readonly uriIdentity: IUriIdentityService
  readonly resolver?: IEditorResolverService
}

export interface OpenTargetOptions {
  readonly pinned?: boolean
  readonly preserveFocus?: boolean
  /** Group to split from; defaults to the active group. */
  readonly sourceGroup?: IEditorGroup
  /** Globally unique inputs (sessions/previews): side/newWindow move, never copy. */
  readonly singleton?: boolean
  /** Fresh instance for an existing input that cannot be cloned. */
  readonly createFresh?: () => EditorInput
}

export interface TargetedOpenResult {
  readonly handled: boolean
  readonly editor?: EditorInput
  readonly group?: IEditorGroup
}

const HANDLED_NONE: TargetedOpenResult = { handled: false }

export function findGroupContaining(
  groups: IEditorGroupsService,
  editor: EditorInput,
): IEditorGroup | undefined {
  return groups.groups.find((group) => group.contains(editor))
}

/** The group a side-open splits from: the active group of the active part.
 *  A source group living in another part (e.g. the file is already open in an
 *  auxiliary window) must not drag the split into that invisible window. */
function splitSource(
  groups: IEditorGroupsService,
  sourceGroup: IEditorGroup | undefined,
): IEditorGroup {
  const active = groups.activeGroup
  if (!sourceGroup || sourceGroup.part !== active.part) return active
  return sourceGroup
}

export function findEditorById(
  groups: IEditorGroupsService,
  id: string,
): { group: IEditorGroup; editor: EditorInput } | undefined {
  for (const group of groups.groups) {
    const editor = group.editors.find((candidate) => candidate.id === id)
    if (editor) return { group, editor }
  }
  return undefined
}

function findEditorByResource(
  groups: IEditorGroupsService,
  uriIdentity: IUriIdentityService,
  resource: URI,
): { group: IEditorGroup; editor: EditorInput } | undefined {
  for (const group of groups.groups) {
    for (const editor of group.editors) {
      if (editor.resource && uriIdentity.isEqual(editor.resource, resource)) {
        return { group, editor }
      }
    }
  }
  return undefined
}

function groupOpenOptions(options: OpenTargetOptions): {
  activate: boolean
  pinned?: boolean
  preserveFocus?: boolean
} {
  return {
    activate: options.preserveFocus !== true,
    ...(options.pinned !== undefined ? { pinned: options.pinned } : {}),
    ...(options.preserveFocus === true ? { preserveFocus: true } : {}),
  }
}

function auxOptions(options: OpenTargetOptions): {
  pinned?: boolean
  activate?: boolean
  preferOtherDisplayFullscreen: boolean
} {
  return {
    ...(options.pinned !== undefined ? { pinned: options.pinned } : {}),
    ...(options.preserveFocus === true ? { activate: false } : {}),
    preferOtherDisplayFullscreen: true,
  }
}

function focusInGroup(
  groups: IEditorGroupsService,
  group: IEditorGroup,
  editor: EditorInput,
): void {
  groups.activateGroup(group)
  group.setActive(editor)
}

/** Open an input that is not mounted in any group. */
export async function openFreshInputWithTarget(
  s: OpenTargetServices,
  input: EditorInput,
  target: OpenTarget,
  options: OpenTargetOptions = {},
): Promise<TargetedOpenResult> {
  if (target === 'default') return HANDLED_NONE

  if (target === 'side') {
    const side = ensureSideGroup(s.groups, splitSource(s.groups, options.sourceGroup))
    openInLockAwareGroup(s.groups, input, groupOpenOptions(options), side)
    const actual = side.editors.find((editor) => editor.id === input.id) ?? input
    return { handled: true, editor: actual, group: side }
  }

  try {
    const result = await s.aux.openEditorInNewWindow(input, {
      mode: 'open',
      ...auxOptions(options),
    })
    if (result.ok) {
      return { handled: true, editor: result.editor, group: result.window.part.activeGroup }
    }
  } catch {
    // The caller falls back to its default path with a fresh instance.
  }
  return HANDLED_NONE
}

/** Open an already-mounted input to the side or into a new window. */
export async function openExistingInputWithTarget(
  s: OpenTargetServices,
  input: EditorInput,
  sourceGroup: IEditorGroup | undefined,
  target: OpenTarget,
  options: OpenTargetOptions = {},
): Promise<TargetedOpenResult> {
  if (target === 'default') return HANDLED_NONE

  const source = sourceGroup ?? findGroupContaining(s.groups, input)
  if (!source) return openFreshInputWithTarget(s, input, target, options)

  if (target === 'side') {
    // Split next to the group that owns the input (so its own side group is
    // reused), unless that group belongs to another window part — then split
    // in the active part instead.
    const side = ensureSideGroup(s.groups, splitSource(s.groups, options.sourceGroup ?? source))
    if (side.contains(input)) {
      focusInGroup(s.groups, side, input)
      return { handled: true, editor: input, group: side }
    }
    if (!options.singleton && canCloneEditorInputForSplit(input)) {
      const clone = s.inst.invokeFunction((accessor) => cloneEditorInputForSplit(input, accessor))
      if (clone) {
        openInLockAwareGroup(s.groups, clone, groupOpenOptions(options), side)
        return { handled: true, editor: clone, group: side }
      }
    }
    const fresh = options.createFresh?.()
    if (fresh) {
      openInLockAwareGroup(s.groups, fresh, groupOpenOptions(options), side)
      return { handled: true, editor: fresh, group: side }
    }
    // Locked groups reject new tabs; move into the lock-aware destination
    // instead of dropping the editor into a group the user froze.
    const moveTo = side.isLocked ? s.groups.activeGroupForOpen : side
    if (moveTo !== source) s.groups.moveEditor(input, moveTo, source)
    focusInGroup(s.groups, moveTo, input)
    return { handled: true, editor: input, group: moveTo }
  }

  const mustMove = options.singleton === true || !canCloneEditorInputForSplit(input)
  try {
    if (!mustMove) {
      const copied = await s.aux.openEditorInNewWindow(input, {
        mode: 'copy',
        source,
        ...auxOptions(options),
      })
      if (copied.ok) {
        return { handled: true, editor: copied.editor, group: copied.window.part.activeGroup }
      }
    }
    const moved = await s.aux.openEditorInNewWindow(input, {
      mode: 'move',
      source,
      ...auxOptions(options),
    })
    if (moved.ok) {
      return { handled: true, editor: moved.editor, group: moved.window.part.activeGroup }
    }
  } catch {
    // fall through
  }
  return HANDLED_NONE
}

/** Open a resource by URI through the editor resolver. */
export async function openUriWithTarget(
  s: OpenTargetServices,
  resource: URI,
  target: OpenTarget,
  options: OpenTargetOptions & { readonly preferredTypeId?: string } = {},
): Promise<TargetedOpenResult> {
  if (target === 'default') return HANDLED_NONE

  if (target === 'newWindow') {
    const existing = findEditorByResource(s.groups, s.uriIdentity, resource)
    if (existing) {
      return openExistingInputWithTarget(s, existing.editor, existing.group, target, options)
    }
  }

  if (!s.resolver) return HANDLED_NONE
  const input = s.resolver.createEditorInput(resource, options.preferredTypeId)

  if (target === 'side') {
    const side = ensureSideGroup(s.groups, splitSource(s.groups, options.sourceGroup))
    openInLockAwareGroup(s.groups, input, groupOpenOptions(options), side)
    const actual = side.editors.find((editor) => editor.id === input.id) ?? input
    return { handled: true, editor: actual, group: side }
  }

  try {
    const result = await s.aux.openEditorInNewWindow(input, {
      mode: 'open',
      ...auxOptions(options),
    })
    if (result.ok) {
      return { handled: true, editor: result.editor, group: result.window.part.activeGroup }
    }
  } catch {
    // fall through to cleanup
  }
  if (!input.isDisposed && !findGroupContaining(s.groups, input)) input.dispose()
  return HANDLED_NONE
}

/**
 * Preview inputs are globally unique. An already-open preview is moved (never
 * copied); otherwise the caller's factory builds the one instance to mount.
 */
export async function openPreviewWithTarget(
  s: OpenTargetServices,
  target: OpenTarget,
  previewId: string,
  createInput: () => EditorInput,
  options: OpenTargetOptions = {},
): Promise<TargetedOpenResult> {
  if (target === 'default') return HANDLED_NONE
  const existing = findEditorById(s.groups, previewId)
  if (existing) {
    return openExistingInputWithTarget(s, existing.editor, existing.group, target, {
      ...options,
      singleton: true,
    })
  }
  const input = createInput()
  const result = await openFreshInputWithTarget(s, input, target, options)
  if (!result.handled && !input.isDisposed && !findGroupContaining(s.groups, input)) input.dispose()
  return result
}
