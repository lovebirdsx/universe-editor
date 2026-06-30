/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  DirtyDiffContribution — VSCode-style "dirty diff" decorations. For the active
 *  file editor it diffs the current document against its git HEAD revision and
 *  paints the change regions: coloured bars in the left gutter (green = added,
 *  blue = modified, red triangle = deleted) and matching marks in the right
 *  overview ruler. HEAD content comes from the `git` extension's
 *  `git.getHeadContent` contributed command; the diff itself runs in-renderer.
 *
 *  HEAD content is cached per path and only invalidated when the SCM model
 *  changes (commit / stage / discard); plain edits re-diff against the cached
 *  HEAD without hitting git.
 *--------------------------------------------------------------------------------------------*/

import {
  Disposable,
  DisposableStore,
  ICommandService,
  IEditorService,
  autorun,
  type URI,
  type IWorkbenchContribution,
} from '@universe-editor/platform'
import { DirtyDiffCommands } from '@universe-editor/extensions-common'
import { FileEditorInput } from '../services/editor/FileEditorInput.js'
import { FileEditorRegistry } from '../services/editor/FileEditorRegistry.js'
import { IDirtyDiffNavigationService } from '../services/scm/DirtyDiffNavigationService.js'
import { IScmDecorationsService } from '../services/scm/ScmDecorationsService.js'
import { MonacoLoader, type monaco } from '../workbench/editor/monaco/MonacoLoader.js'
import { computeDirtyDiffRegions, type DirtyDiffRegion } from './dirtyDiff.js'

const COLORS = {
  added: '#2ea043',
  modified: '#0c7d9d',
  deleted: '#c74e39',
} as const

export class DirtyDiffContribution extends Disposable implements IWorkbenchContribution {
  private _decorations: monaco.editor.IEditorDecorationsCollection | undefined
  private _activeEditor: monaco.editor.IStandaloneCodeEditor | undefined
  private _activeResource: URI | undefined
  private _activePath: string | undefined

  private readonly _editorStore = this._register(new DisposableStore())
  private readonly _registryStore = this._register(new DisposableStore())

  /** HEAD content per absolute path; null = no HEAD revision (new file). */
  private readonly _headCache = new Map<string, string | null>()
  private readonly _inflight = new Map<string, Promise<string | null>>()

  constructor(
    @IEditorService editorService: IEditorService,
    @ICommandService private readonly _commandService: ICommandService,
    @IScmDecorationsService scmDecorationsService: IScmDecorationsService,
    @IDirtyDiffNavigationService private readonly _navigation: IDirtyDiffNavigationService,
  ) {
    super()

    this._register(
      autorun((r) => {
        const active = editorService.activeEditor.read(r)
        if (active instanceof FileEditorInput) {
          this._bind(active)
        } else {
          this._clear()
        }
      }),
    )

    // SCM changed (commit / stage / discard) → the HEAD revision may differ now.
    this._register(
      autorun((r) => {
        scmDecorationsService.decorations.read(r)
        this._headCache.clear()
        if (this._activePath) {
          this._headCache.delete(this._activePath)
          this._refresh()
        }
      }),
    )

    this._register({ dispose: () => this._clear() })
  }

  private _bind(input: FileEditorInput): void {
    this._activeResource = input.resource
    this._activePath = input.resource.fsPath
    this._editorStore.clear()
    this._registryStore.clear()

    const attach = (): void => {
      this._editorStore.clear()
      const editor = FileEditorRegistry.get(input)
      this._activeEditor = editor
      this._decorations = editor?.createDecorationsCollection()
      if (!editor) return

      const model = editor.getModel()
      if (model) {
        this._editorStore.add(model.onDidChangeContent(() => this._refresh()))
      }
      this._refresh()
    }

    attach()
    this._registryStore.add(
      FileEditorRegistry.onDidChange((changed) => {
        if (changed === input) attach()
      }),
    )
  }

  private _refresh(): void {
    const editor = this._activeEditor
    const resource = this._activeResource
    const path = this._activePath
    if (!editor || !resource || !path) return

    void this._getHead(path).then((head) => {
      if (
        this._activeEditor !== editor ||
        this._activeResource !== resource ||
        this._activePath !== path
      )
        return
      const model = editor.getModel()
      if (!model) return
      // No HEAD revision means the file is outside the repo (not a workspace file)
      // or untracked / brand new — VSCode shows no dirty-diff marks for either.
      if (head === null) {
        this._render(resource, head, [])
        return
      }
      const regions = computeDirtyDiffRegions(head, model.getValue())
      this._render(resource, head, regions)
    })
  }

  private _getHead(path: string): Promise<string | null> {
    if (this._headCache.has(path)) return Promise.resolve(this._headCache.get(path) ?? null)
    const existing = this._inflight.get(path)
    if (existing) return existing

    const p = this._commandService
      .executeCommand<string | null>(DirtyDiffCommands.getHeadContent, path)
      .then((r) => {
        this._inflight.delete(path)
        // `undefined` = command not registered yet (extension host activating);
        // don't cache so a later edit retries. `null` = no HEAD revision; cache it.
        if (r === undefined) return null
        this._headCache.set(path, r)
        return r
      })
      .catch(() => {
        this._inflight.delete(path)
        return null
      })
    this._inflight.set(path, p)
    return p
  }

  private _render(
    resource: URI,
    headContent: string | null,
    regions: readonly DirtyDiffRegion[],
  ): void {
    this._navigation.setState({ resource, headContent, regions })
    const collection = this._decorations
    if (!collection) return
    if (regions.length === 0) {
      collection.clear()
      return
    }
    const m = MonacoLoader.get()
    collection.set(
      regions.map((region) => ({
        range: new m.Range(region.startLine, 1, region.endLine, 1),
        options: {
          isWholeLine: true,
          linesDecorationsClassName: `dirty-diff-gutter dirty-diff-gutter-${region.kind}`,
          overviewRuler: {
            color: COLORS[region.kind],
            position: m.editor.OverviewRulerLane.Left,
          },
        },
      })),
    )
  }

  private _clear(): void {
    this._navigation.setState({ resource: undefined, headContent: undefined, regions: [] })
    this._editorStore.clear()
    this._registryStore.clear()
    this._decorations?.clear()
    this._decorations = undefined
    this._activeEditor = undefined
    this._activeResource = undefined
    this._activePath = undefined
  }
}
