/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Diff-related built-in actions. `_workbench.openDiff` is an internal command
 *  (no command-palette entry) the extension host invokes to surface a diff it
 *  computed — e.g. the Git extension's "open changes". The host can't construct
 *  an EditorInput, so it ships the already-resolved text and we build the input.
 *--------------------------------------------------------------------------------------------*/

import {
  Action2,
  IEditorGroupsService,
  IInstantiationService,
  MenuId,
  URI,
  localize2,
  type ServicesAccessor,
} from '@universe-editor/platform'
import { DiffEditorInput } from '../services/editor/DiffEditorInput.js'
import { DiffEditorRegistry } from '../services/editor/DiffEditorRegistry.js'
import { FileEditorInput } from '../services/editor/FileEditorInput.js'
import { WebviewDiffInput } from '../services/editor/WebviewDiffInput.js'

export interface OpenDiffPayload {
  readonly title: string
  /** Serialized `file:` URI naming the file under comparison (used for the label/language). */
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
   * button should open. Omit when the diff has no local source (depot/revision
   * blobs, cross-file compare) — the button is then hidden.
   */
  readonly openableUri?: string
}

export class OpenDiffAction extends Action2 {
  static readonly ID = '_workbench.openDiff'

  constructor() {
    super({ id: OpenDiffAction.ID, title: 'Open Diff' })
  }

  override run(accessor: ServicesAccessor, payload: OpenDiffPayload): void {
    const groups = accessor.get(IEditorGroupsService)
    const group = groups.activeGroup
    const id = `diff:${URI.parse(payload.originalUri).toString()}`

    const pinned = payload.pinned ?? false
    const preserveFocus = payload.preserveFocus ?? false

    // Reuse an already-open diff for the same file: refresh its content in place
    // and re-activate, instead of opening a duplicate.
    const existing = group.editors.find((e) => e.id === id)
    if (existing instanceof DiffEditorInput) {
      existing.update(payload.original, payload.modified)
      // Double-click (pinned=true) promotes a preview tab to permanent.
      group.openEditor(existing, { activate: true, pinned, preserveFocus })
      return
    }

    const input = new DiffEditorInput(
      URI.parse(payload.originalUri),
      payload.original,
      payload.modified,
      undefined,
      payload.openableUri ? URI.parse(payload.openableUri) : undefined,
    )
    // Single-click uses the preview slot; double-click opens a permanent tab.
    group.openEditor(input, { activate: true, pinned, preserveFocus })
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
  /** Serialized `file:` URI of the left-hand (baseline) side, for labels. */
  readonly leftUri: string
  /** Serialized `file:` URI of the right-hand (modified) side, for labels. */
  readonly rightUri: string
  /** Base64-encoded bytes of the left-hand side. */
  readonly leftBase64: string
  /** Base64-encoded bytes of the right-hand side. */
  readonly rightBase64: string
  readonly pinned?: boolean
  readonly preserveFocus?: boolean
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
    super({ id: OpenWebviewDiffAction.ID, title: 'Open Webview Diff' })
  }

  override run(accessor: ServicesAccessor, payload: OpenWebviewDiffPayload): void {
    const groups = accessor.get(IEditorGroupsService)
    const group = groups.activeGroup
    const leftUri = URI.parse(payload.leftUri)
    const rightUri = URI.parse(payload.rightUri)
    const pinned = payload.pinned ?? false
    const preserveFocus = payload.preserveFocus ?? false

    const input = new WebviewDiffInput(
      payload.viewType,
      leftUri,
      rightUri,
      fromBase64(payload.leftBase64),
      fromBase64(payload.rightBase64),
      payload.title,
    )

    // Reuse an already-open diff for the same identity (viewType + both URIs):
    // re-activate it instead of opening a duplicate.
    const existing = group.editors.find((e) => e.id === input.id)
    if (existing) {
      group.openEditor(existing, { activate: true, pinned, preserveFocus })
      return
    }
    group.openEditor(input, { activate: true, pinned, preserveFocus })
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

  override run(accessor: ServicesAccessor): void {
    const group = accessor.get(IEditorGroupsService).activeGroup
    const active = group.activeEditor
    if (!(active instanceof DiffEditorInput)) return
    const resource = active.openableResource
    if (!resource) return
    const input = accessor.get(IInstantiationService).createInstance(FileEditorInput, resource)
    group.openEditor(input, { activate: true, pinned: true })
  }
}

function goToDiff(accessor: ServicesAccessor, target: 'next' | 'previous'): void {
  const group = accessor.get(IEditorGroupsService).activeGroup
  const active = group.activeEditor
  if (!(active instanceof DiffEditorInput)) return
  DiffEditorRegistry.get(active, group.id)?.goToDiff(target)
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

  override run(accessor: ServicesAccessor): void {
    goToDiff(accessor, 'next')
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

  override run(accessor: ServicesAccessor): void {
    goToDiff(accessor, 'previous')
  }
}
