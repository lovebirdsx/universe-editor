/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Diff-related built-in actions. `_workbench.openDiff` is an internal command
 *  (no command-palette entry) the extension host invokes to surface a diff it
 *  computed — e.g. the Git extension's "open changes". The host can't construct
 *  an EditorInput, so it ships the already-resolved text and we build the input.
 *--------------------------------------------------------------------------------------------*/

import {
  Action2,
  IContextKeyService,
  IEditorGroupsService,
  IInstantiationService,
  IWorkspaceService,
  MenuId,
  REMOTE_SCHEME,
  URI,
  absolutePathToWorkspaceUri,
  localize2,
  type EditorInput,
  type IEditorGroup,
  type ServicesAccessor,
} from '@universe-editor/platform'
import {
  activateGroupAndFocus,
  type ActivateGroupFocusContext,
} from '../services/editor/activateGroupAndFocus.js'
import { DiffEditorInput } from '../services/editor/DiffEditorInput.js'
import { DiffEditorRegistry } from '../services/editor/DiffEditorRegistry.js'
import { FileEditorInput } from '../services/editor/FileEditorInput.js'
import { WebviewDiffInput } from '../services/editor/WebviewDiffInput.js'
import { openInLockAwareGroup } from '../services/editor/openInLockAwareGroup.js'
import { ensureSideGroup } from '../services/editor/openToSide.js'
import { invocationOpenTarget, type TargetedOpen } from '../services/editor/openTarget.js'
import {
  openFreshInputWithTarget,
  openTargetServicesFrom,
  openUriEditor,
} from '../services/editor/openWithTarget.js'
import { IWindowFocusService } from '../services/windows/windowFocusService.js'
import { resolveTargetEditor } from './editorActionHelpers.js'

export interface OpenDiffPayload {
  readonly title: string
  /**
   * Serialized `file:` URI naming the file under comparison (used for the label/
   * language). Produced on the provider host via `pathToFileURL`, so it travels as
   * a bare string that bypasses the codec's URI translation (a documented protocol
   * exception) — in a remote workspace the renderer re-attaches the current
   * workspace authority.
   */
  readonly originalUri: string
  /** Left-hand side content (e.g. the HEAD or staged version). */
  readonly original: string
  /** Right-hand side content (e.g. the working-tree version). */
  readonly modified: string
  /** When true the editor opens (or is promoted) as a permanent tab, ending preview state. */
  readonly pinned?: boolean
  /** When true the diff opens without stealing focus (e.g. Space-preview from the SCM list). */
  readonly preserveFocus?: boolean
  /**
   * Serialized `file:` URI of the real on-disk file the "Open File" title-bar
   * button should open, with the same provider-host / codec-bypass caveat as
   * {@link originalUri}. Omit when the diff has no local source (depot/revision
   * blobs, cross-file compare) — the button is then hidden.
   */
  readonly openableUri?: string
  /**
   * True when the modified side IS the live working tree: it then tracks the
   * file's editor buffer and external disk changes. Omit (or false) for
   * snapshot diffs — commit-to-commit, depot revisions, merge-conflict sides —
   * whose right side must stay frozen at the passed content.
   */
  readonly liveModified?: boolean
  /**
   * Group the diff belongs to (the group the command was invoked from). Omit for
   * opens without a source surface — they follow the open target.
   */
  readonly groupId?: number
  /** Where to open: omitted = the resolved group / open-target path. */
  readonly openTarget?: TargetedOpen
}

/**
 * The group a diff or merge belongs to: an explicit `groupId` from the invoking
 * surface, else the open target (diff opens are opens, not command targets).
 */
function resolveDiffTargetGroup(
  groups: IEditorGroupsService,
  groupId: number | undefined,
): IEditorGroup {
  return (groupId !== undefined ? groups.getGroup(groupId) : undefined) ?? groups.openTargetGroup
}

/**
 * Reveal an already-open diff: activation alone doesn't move focus into an
 * editor that is already active, so an explicit reveal must focus the group
 * (and bring its window forward) itself. Callers hand in services captured
 * synchronously — this also runs from the async new-window fallback, after the
 * `ServicesAccessor` has expired.
 */
function revealExistingDiff(
  ctx: ActivateGroupFocusContext,
  group: IEditorGroup,
  editor: EditorInput,
): void {
  activateGroupAndFocus(group, ctx, editor)
}

/**
 * Resolve a provider-host `file:` URI string to the workspace resource it names.
 * The extension host emits `pathToFileURL(...)` strings that bypass the codec's
 * URI translation (a bare string, not a UriComponents), so a `file:` URI here
 * points at the *remote* filesystem — re-attach the current workspace's authority
 * when it is a remote folder. Non-`file` URIs (already `remote-ssh://...` from a
 * renderer-internal caller) and local workspaces pass through unchanged.
 */
function toWorkspaceResource(uriString: string, folder: URI | undefined): URI {
  const parsed = URI.parse(uriString)
  if (parsed.scheme === 'file' && folder?.scheme === REMOTE_SCHEME) {
    return absolutePathToWorkspaceUri(parsed.fsPath, folder)
  }
  return parsed
}

export class OpenDiffAction extends Action2 {
  static readonly ID = '_workbench.openDiff'

  constructor() {
    super({ id: OpenDiffAction.ID, title: localize2('action.diff.openDiff', 'Open Diff') })
  }

  override run(accessor: ServicesAccessor, payload: OpenDiffPayload): void {
    const groups = accessor.get(IEditorGroupsService)
    const folder = accessor.get(IWorkspaceService).current?.folder
    const inst = accessor.get(IInstantiationService)
    // Snapshot before any async fallback: the accessor dies at the first await,
    // but the new-window failure path reveals through it later.
    const focusContext: ActivateGroupFocusContext = {
      groups,
      contextKeyService: accessor.get(IContextKeyService),
      windowFocus: accessor.get(IWindowFocusService),
    }
    const explicitGroup =
      payload.groupId !== undefined ? groups.getGroup(payload.groupId) : undefined
    const targetGroup = resolveDiffTargetGroup(groups, payload.groupId)
    const resource = toWorkspaceResource(payload.originalUri, folder)
    const id = `diff:${resource.toString()}`

    const pinned = payload.pinned ?? false
    const preserveFocus = payload.preserveFocus ?? false

    const createInput = (): DiffEditorInput =>
      inst.createInstance(
        DiffEditorInput,
        resource,
        payload.original,
        payload.modified,
        undefined,
        payload.openableUri ? toWorkspaceResource(payload.openableUri, folder) : undefined,
        payload.liveModified ?? false,
      )

    const openDefault = (): void => {
      // Reuse an already-open diff for the same file: refresh its content in place
      // and re-activate, instead of opening a duplicate. Revealing an existing tab
      // stays in its group even when that group is locked.
      const existing = targetGroup.editors.find((e) => e.id === id)
      if (existing instanceof DiffEditorInput) {
        existing.update(payload.original, payload.modified, payload.liveModified ?? false)
        // Double-click (pinned=true) promotes a preview tab to permanent.
        targetGroup.openEditor(existing, { activate: true, pinned, preserveFocus })
        if (!preserveFocus) revealExistingDiff(focusContext, targetGroup, existing)
        return
      }

      const input = createInput()
      // A brand-new diff respects the group lock: route to an unlocked group and
      // surface it (unless this is a focus-preserving preview).
      const group =
        explicitGroup !== undefined && !explicitGroup.isLocked
          ? explicitGroup
          : groups.activeGroupForOpen
      // Single-click uses the preview slot; double-click opens a permanent tab.
      group.openEditor(input, { activate: true, pinned, preserveFocus })
      if (group !== targetGroup && !preserveFocus) groups.activateGroup(group)
    }

    const target = payload.openTarget
    if (target === undefined) {
      openDefault()
      return
    }

    if (target === 'side') {
      const side = ensureSideGroup(groups)
      const existing = side.editors.find((e) => e.id === id)
      if (existing instanceof DiffEditorInput) {
        existing.update(payload.original, payload.modified, payload.liveModified ?? false)
        side.openEditor(existing, { activate: true, pinned, preserveFocus })
        if (!preserveFocus) revealExistingDiff(focusContext, side, existing)
        return
      }
      openInLockAwareGroup(groups, createInput(), { activate: true, pinned, preserveFocus }, side)
      return
    }

    const services = openTargetServicesFrom(accessor)
    const input = createInput()
    void openFreshInputWithTarget(services, input, target, { pinned, preserveFocus }).then(
      (result) => {
        if (result.handled) return
        if (!input.isDisposed) input.dispose()
        openDefault()
      },
    )
  }
}

/**
 * Payload for `_workbench.openWebviewDiff` — the extension-host counterpart of
 * `_workbench.openDiff`, but for a diff rendered by an extension's custom editor
 * (webview) instead of Monaco. The two sides' bytes are passed by value (base64)
 * because they may not exist on disk (a Git HEAD blob, a Perforce have-revision),
 * exactly like `openDiff` ships already-resolved text.
 */
export interface OpenWebviewDiffPayload {
  /** The custom-editor viewType that renders this diff (e.g. `universe.excel`). */
  readonly viewType: string
  readonly title: string
  /**
   * Serialized `file:` URI of the left-hand (baseline) side, for labels. Provider
   * host `pathToFileURL(...)` string that bypasses the codec's URI translation
   * (documented protocol exception) — re-attached to the workspace authority in a
   * remote workspace.
   */
  readonly leftUri: string
  /**
   * Serialized `file:` URI of the right-hand (modified) side, for labels. Same
   * provider-host / codec-bypass caveat as {@link leftUri}.
   */
  readonly rightUri: string
  /** Base64-encoded bytes of the left-hand side. */
  readonly leftBase64: string
  /** Base64-encoded bytes of the right-hand side. */
  readonly rightBase64: string
  readonly pinned?: boolean
  readonly preserveFocus?: boolean
  /** Group the diff belongs to; omitted = the open target. See {@link OpenDiffPayload.groupId}. */
  readonly groupId?: number
  /** Where to open: omitted = the resolved group / open-target path. */
  readonly openTarget?: TargetedOpen
}

/** Decode base64 (from the JSON payload) back into bytes for the input. */
function fromBase64(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/**
 * Open (or re-activate) a webview-rendered diff. Mirrors {@link OpenDiffAction}
 * but builds a WebviewDiffInput, letting the owning extension render the two
 * sides in its custom editor (e.g. a spreadsheet diff) rather than Monaco.
 */
export class OpenWebviewDiffAction extends Action2 {
  static readonly ID = '_workbench.openWebviewDiff'

  constructor() {
    super({
      id: OpenWebviewDiffAction.ID,
      title: localize2('action.diff.openWebviewDiff', 'Open Webview Diff'),
    })
  }

  override run(accessor: ServicesAccessor, payload: OpenWebviewDiffPayload): void {
    const groups = accessor.get(IEditorGroupsService)
    const folder = accessor.get(IWorkspaceService).current?.folder
    // Snapshot before any async fallback: the accessor dies at the first await,
    // but the new-window failure path reveals through it later.
    const focusContext: ActivateGroupFocusContext = {
      groups,
      contextKeyService: accessor.get(IContextKeyService),
      windowFocus: accessor.get(IWindowFocusService),
    }
    const explicitGroup =
      payload.groupId !== undefined ? groups.getGroup(payload.groupId) : undefined
    const targetGroup = resolveDiffTargetGroup(groups, payload.groupId)
    const leftUri = toWorkspaceResource(payload.leftUri, folder)
    const rightUri = toWorkspaceResource(payload.rightUri, folder)
    const pinned = payload.pinned ?? false
    const preserveFocus = payload.preserveFocus ?? false

    const createInput = (): WebviewDiffInput =>
      new WebviewDiffInput(
        payload.viewType,
        leftUri,
        rightUri,
        fromBase64(payload.leftBase64),
        fromBase64(payload.rightBase64),
        payload.title,
      )

    const openDefault = (): void => {
      const input = createInput()
      // Reuse an already-open diff for the same identity (viewType + both URIs):
      // re-activate it instead of opening a duplicate.
      const existing = targetGroup.editors.find((e) => e.id === input.id)
      if (existing) {
        targetGroup.openEditor(existing, { activate: true, pinned, preserveFocus })
        if (!preserveFocus) revealExistingDiff(focusContext, targetGroup, existing)
        return
      }
      const group =
        explicitGroup !== undefined && !explicitGroup.isLocked
          ? explicitGroup
          : groups.activeGroupForOpen
      group.openEditor(input, { activate: true, pinned, preserveFocus })
      if (group !== targetGroup && !preserveFocus) groups.activateGroup(group)
    }

    const target = payload.openTarget
    if (target === undefined) {
      openDefault()
      return
    }

    if (target === 'side') {
      const side = ensureSideGroup(groups)
      const input = createInput()
      const existing = side.editors.find((e) => e.id === input.id)
      if (existing) {
        side.openEditor(existing, { activate: true, pinned, preserveFocus })
        if (!preserveFocus) revealExistingDiff(focusContext, side, existing)
        return
      }
      openInLockAwareGroup(groups, input, { activate: true, pinned, preserveFocus }, side)
      return
    }

    const services = openTargetServicesFrom(accessor)
    const input = createInput()
    void openFreshInputWithTarget(services, input, target, { pinned, preserveFocus }).then(
      (result) => {
        if (result.handled) return
        if (!input.isDisposed) input.dispose()
        openDefault()
      },
    )
  }
}

/**
 * Opens the real on-disk source file backing the active diff, mirroring VSCode's
 * "Open File" button in the diff editor title bar. Only visible when the diff
 * declared an `openableResource` (see DiffEditorInput) — diffs over depot or
 * revision blobs, or Explorer cross-file compares, have none and hide the button.
 */
export class OpenDiffSourceFileAction extends Action2 {
  static readonly ID = 'workbench.action.diffEditor.openFile'

  constructor() {
    super({
      id: OpenDiffSourceFileAction.ID,
      title: localize2('action.diffEditor.openFile.title', 'Open File'),
      category: localize2('command.category.diffEditor', 'Diff Editor'),
      icon: 'go-to-file',
      precondition: 'isInDiffEditor && diffEditorHasOpenableFile',
      keybinding: { primary: 'shift+alt+y', when: 'isInDiffEditor && diffEditorHasOpenableFile' },
      menu: [
        {
          id: MenuId.EditorTitle,
          group: 'navigation',
          order: 1,
          when: 'isInDiffEditor && diffEditorHasOpenableFile',
        },
      ],
      f1: true,
    })
  }

  override run(accessor: ServicesAccessor, arg?: unknown): Promise<boolean> | undefined {
    const target = resolveTargetEditor(accessor, arg)
    if (!target) return undefined
    const group = target.group
    const active = target.editor
    if (!(active instanceof DiffEditorInput)) return undefined
    const resource = active.openableResource
    if (!resource) return undefined
    const inst = accessor.get(IInstantiationService)
    const createInput = (): FileEditorInput => inst.createInstance(FileEditorInput, resource)
    return openUriEditor(
      openTargetServicesFrom(accessor),
      invocationOpenTarget(),
      resource,
      () => group.openEditor(createInput(), { activate: true, pinned: true }),
      { createInput, pinned: true, sourceGroup: group },
    )
  }
}

function goToDiff(accessor: ServicesAccessor, direction: 'next' | 'previous', arg?: unknown): void {
  const target = resolveTargetEditor(accessor, arg)
  if (!target) return
  const { group, editor: active } = target
  if (!(active instanceof DiffEditorInput)) return
  DiffEditorRegistry.get(active, group.id)?.goToDiff(direction)
}

export class GoToNextDifferenceAction extends Action2 {
  static readonly ID = 'workbench.action.compareEditor.nextChange'

  constructor() {
    super({
      id: GoToNextDifferenceAction.ID,
      title: localize2('action.diffEditor.nextChange.title', 'Go to Next Difference'),
      category: localize2('command.category.diffEditor', 'Diff Editor'),
      icon: 'diff-next-change',
      keybinding: { primary: 'alt+f5' },
      precondition: 'isInDiffEditor',
      menu: [{ id: MenuId.EditorTitle, group: 'navigation', order: 3, when: 'isInDiffEditor' }],
      f1: true,
    })
  }

  override run(accessor: ServicesAccessor, arg?: unknown): void {
    goToDiff(accessor, 'next', arg)
  }
}

export class GoToPreviousDifferenceAction extends Action2 {
  static readonly ID = 'workbench.action.compareEditor.previousChange'

  constructor() {
    super({
      id: GoToPreviousDifferenceAction.ID,
      title: localize2('action.diffEditor.previousChange.title', 'Go to Previous Difference'),
      category: localize2('command.category.diffEditor', 'Diff Editor'),
      icon: 'diff-previous-change',
      keybinding: { primary: 'shift+alt+f5' },
      precondition: 'isInDiffEditor',
      menu: [{ id: MenuId.EditorTitle, group: 'navigation', order: 2, when: 'isInDiffEditor' }],
      f1: true,
    })
  }

  override run(accessor: ServicesAccessor, arg?: unknown): void {
    goToDiff(accessor, 'previous', arg)
  }
}
