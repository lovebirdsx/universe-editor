/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Fake IEditorGroupsService for tests. OutlineService tracks one
 *  EditorOutlineTracker per editor group (so a split view's breadcrumbs each
 *  follow their own group), which means unit tests need real group lifecycle —
 *  add / activate / remove — rather than a single global "active editor".
 *  `makeEditorGroups` covers the common single-group shape; tests that exercise
 *  a split view drive `FakeEditorGroups` directly.
 *--------------------------------------------------------------------------------------------*/

import {
  autorun,
  Emitter,
  Event,
  type EditorInput,
  type IEditorGroup,
  type IEditorGroupsService,
  type IObservable,
} from '@universe-editor/platform'

/** The group id `makeEditorGroups` hands to its single, mirroring group. */
export const SINGLE_GROUP_ID = 1

/** Minimal IEditorGroup: the id, the active editor, and the change event that
 *  makes an outline tracker re-attach. */
export class FakeGroup {
  private _activeEditor: EditorInput | undefined
  private readonly _onDidActiveEditorChange = new Emitter<void>()
  readonly onDidActiveEditorChange: Event<void> = this._onDidActiveEditorChange.event

  constructor(readonly id: number) {}

  get activeEditor(): EditorInput | undefined {
    return this._activeEditor
  }

  setActiveEditor(input: EditorInput | undefined): void {
    if (this._activeEditor === input) return
    this._activeEditor = input
    this._onDidActiveEditorChange.fire()
  }
}

/** Minimal IEditorGroupsService: consumers only read `groups` / `activeGroup` and
 *  follow add / remove / activate. */
export class FakeEditorGroups {
  private readonly _groups: FakeGroup[] = []
  private _active: FakeGroup | undefined
  private _nextId = 1
  private readonly _onDidActiveGroupChange = new Emitter<IEditorGroup>()
  private readonly _onDidAddGroup = new Emitter<IEditorGroup>()
  private readonly _onDidRemoveGroup = new Emitter<IEditorGroup>()

  readonly onDidActiveGroupChange: Event<IEditorGroup> = this._onDidActiveGroupChange.event
  readonly onDidAddGroup: Event<IEditorGroup> = this._onDidAddGroup.event
  readonly onDidRemoveGroup: Event<IEditorGroup> = this._onDidRemoveGroup.event

  get groups(): readonly IEditorGroup[] {
    return this._groups as unknown as IEditorGroup[]
  }

  get activeGroup(): IEditorGroup {
    return this._active as unknown as IEditorGroup
  }

  /** Mirror `source` into the first group — the single-editor shape most tests
   *  want. */
  mirror<T extends EditorInput>(source: IObservable<T | undefined>): void {
    const group = this._groups[0]
    if (!group) return
    autorun((r) => group.setActiveEditor(source.read(r)))
  }

  addGroup(): FakeGroup {
    const group = new FakeGroup(this._nextId++)
    this._groups.push(group)
    this._active ??= group
    this._onDidAddGroup.fire(group as unknown as IEditorGroup)
    return group
  }

  activate(group: FakeGroup): void {
    if (this._active === group) return
    this._active = group
    this._onDidActiveGroupChange.fire(group as unknown as IEditorGroup)
  }

  remove(group: FakeGroup): void {
    const index = this._groups.indexOf(group)
    if (index === -1) return
    this._groups.splice(index, 1)
    if (this._active === group) {
      const next = this._groups[0]
      if (next) {
        this._active = next
        this._onDidActiveGroupChange.fire(next as unknown as IEditorGroup)
      }
    }
    this._onDidRemoveGroup.fire(group as unknown as IEditorGroup)
  }
}

/** Build a groups service whose single group (id `SINGLE_GROUP_ID`) mirrors
 *  `activeEditor`. */
export function makeEditorGroups<T extends EditorInput>(
  activeEditor: IObservable<T | undefined>,
): IEditorGroupsService {
  const groups = new FakeEditorGroups()
  groups.addGroup()
  groups.mirror(activeEditor)
  return groups as unknown as IEditorGroupsService
}
