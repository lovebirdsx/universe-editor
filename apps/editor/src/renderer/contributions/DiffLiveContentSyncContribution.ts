/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  DiffLiveContentSyncContribution — keep an open diff tab's modified side in
 *  sync with live edits to its underlying file.
 *
 *  A DiffEditorInput renders its own *temporary* Monaco models (synthetic URIs),
 *  decoupled from the shared MonacoModelRegistry model that a plain FileEditor on
 *  the same file uses. So editing the file (in the same group after switching, or
 *  side-by-side in a split group) never reached the diff — its modified side
 *  stayed frozen at the snapshot captured when the diff opened.
 *
 *  This contribution bridges the two: for every open DiffEditorInput it finds the
 *  shared text model for its originalUri and, on each content change (including
 *  unsaved/dirty edits), pushes the live text into the diff's modified side via
 *  DiffEditorInput.update(). update() refreshes the mounted Monaco models in
 *  place, and also updates the input's fields so a later remount (switching back
 *  to the tab) shows the fresh content. The baseline (original side) is left
 *  untouched.
 *--------------------------------------------------------------------------------------------*/

import {
  Disposable,
  IEditorGroupsService,
  type IDisposable,
  type IEditorGroup,
  type IWorkbenchContribution,
} from '@universe-editor/platform'
import { DiffEditorInput } from '../services/editor/DiffEditorInput.js'
import { MonacoModelRegistry } from '../workbench/editor/monaco/MonacoModelRegistry.js'
import type { monaco } from '../workbench/editor/monaco/MonacoLoader.js'

interface ModelSub {
  readonly model: monaco.editor.ITextModel
  readonly store: IDisposable
}

export class DiffLiveContentSyncContribution extends Disposable implements IWorkbenchContribution {
  private readonly _subs = new Map<DiffEditorInput, ModelSub>()
  private readonly _groupSubs = new Map<number, IDisposable>()

  constructor(@IEditorGroupsService private readonly _groups: IEditorGroupsService) {
    super()

    for (const group of this._groups.groups) this._attachGroup(group)
    this._register(
      this._groups.onDidAddGroup((group) => {
        this._attachGroup(group)
        this._reconcile()
      }),
    )
    this._register(
      this._groups.onDidRemoveGroup((group) => {
        this._detachGroup(group.id)
        this._reconcile()
      }),
    )
    // A diff can open before its file's model exists (file not open yet); pick it
    // up once the shared model appears.
    this._register(MonacoModelRegistry.onDidAddModel(() => this._reconcile()))

    this._reconcile()
  }

  override dispose(): void {
    for (const { store } of this._subs.values()) store.dispose()
    this._subs.clear()
    this._groupSubs.clear()
    super.dispose()
  }

  private _attachGroup(group: IEditorGroup): void {
    if (this._groupSubs.has(group.id)) return
    const d = this._register(
      group.onDidChangeModel((e) => {
        if (e.kind === 'open' || e.kind === 'close') this._reconcile()
      }),
    )
    this._groupSubs.set(group.id, d)
  }

  private _detachGroup(id: number): void {
    const d = this._groupSubs.get(id)
    if (d) {
      d.dispose()
      this._groupSubs.delete(id)
    }
  }

  private _reconcile(): void {
    const open = new Set<DiffEditorInput>()
    for (const group of this._groups.groups) {
      for (const editor of group.editors) {
        if (editor instanceof DiffEditorInput) open.add(editor)
      }
    }

    // Drop subscriptions for diffs that closed or whose model went away.
    for (const [input, sub] of this._subs) {
      if (!open.has(input) || sub.model.isDisposed()) {
        sub.store.dispose()
        this._subs.delete(input)
      }
    }

    // (Re)subscribe each open diff to its file's shared model.
    for (const input of open) {
      const model = MonacoModelRegistry.peek(input.originalUri)
      if (!model || model.isDisposed()) continue
      const existing = this._subs.get(input)
      if (existing && existing.model === model) continue
      existing?.store.dispose()
      const store = model.onDidChangeContent(() => {
        input.update(input.originalContent, model.getValue())
      })
      this._subs.set(input, { model, store })
      // Initial sync: the file may already hold unsaved edits made before the
      // diff opened. update() is a no-op when the content already matches.
      input.update(input.originalContent, model.getValue())
    }
  }
}
