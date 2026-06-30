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
 *  Clicking a gutter bar opens an inline peek (InlineDirtyDiffController) showing
 *  that change's HEAD ↔ current line diff plus Revert / Stage / Open Changes /
 *  navigation actions, mirroring VSCode's QuickDiffWidget.
 *
 *  HEAD content is cached per path and only invalidated when the SCM model
 *  changes (commit / stage / discard); plain edits re-diff against the cached
 *  HEAD without hitting git.
 *--------------------------------------------------------------------------------------------*/

import {
  Disposable,
  DisposableStore,
  ICommandService,
  IContextKeyService,
  IEditorService,
  autorun,
  type IContextKey,
  type URI,
  type IWorkbenchContribution,
} from '@universe-editor/platform'
import { DirtyDiffCommands } from '@universe-editor/extensions-common'
import { FileEditorInput } from '../services/editor/FileEditorInput.js'
import { FileEditorRegistry } from '../services/editor/FileEditorRegistry.js'
import { IDirtyDiffNavigationService } from '../services/scm/DirtyDiffNavigationService.js'
import { IScmDecorationsService } from '../services/scm/ScmDecorationsService.js'
import { MonacoLoader, type monaco } from '../workbench/editor/monaco/MonacoLoader.js'
import { InlineDirtyDiffController } from '../workbench/scm/dirtyDiff/InlineDirtyDiffController.js'
import {
  DirtyDiffPeekRegistry,
  type IDirtyDiffPeekHost,
} from '../workbench/scm/dirtyDiff/DirtyDiffPeekRegistry.js'
import { computeDirtyDiffRegions, type DirtyDiffRegion } from './dirtyDiff.js'

/** Context key VSCode names `dirtyDiffVisible`; gates the Esc close keybinding. */
export const DIRTY_DIFF_PEEK_VISIBLE = 'dirtyDiffPeekVisible'

const COLORS = {
  added: '#2ea043',
  modified: '#0c7d9d',
  deleted: '#c74e39',
} as const

export class DirtyDiffContribution
  extends Disposable
  implements IWorkbenchContribution, IDirtyDiffPeekHost
{
  private _decorations: monaco.editor.IEditorDecorationsCollection | undefined
  private _activeEditor: monaco.editor.IStandaloneCodeEditor | undefined
  private _activeResource: URI | undefined
  private _activePath: string | undefined
  private _controller: InlineDirtyDiffController | undefined
  private _regions: readonly DirtyDiffRegion[] = []
  private _headText = ''
  /** Set on gutter mousedown, consumed on the matching mouseup (VSCode parity). */
  private _mouseDownLine: number | undefined
  private readonly _peekVisible: IContextKey<boolean>

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
    @IContextKeyService contextKeyService: IContextKeyService,
  ) {
    super()

    this._peekVisible = contextKeyService.createKey<boolean>(DIRTY_DIFF_PEEK_VISIBLE, false)
    DirtyDiffPeekRegistry.setHost(this)
    this._register({ dispose: () => DirtyDiffPeekRegistry.clearHost(this) })

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
      this._controller = undefined
      if (!editor) return

      this._controller = this._editorStore.add(
        new InlineDirtyDiffController(editor, {
          onRevert: (region) => this._revert(region),
          onStage: (region) => void this._stage(region),
          onOpenChanges: () => void this._openChanges(),
        }),
      )

      const model = editor.getModel()
      if (model) {
        this._editorStore.add(model.onDidChangeContent(() => this._refresh()))
      }
      this._editorStore.add(editor.onMouseDown((e) => this._onMouseDown(e)))
      this._editorStore.add(editor.onMouseUp((e) => this._onMouseUp(e)))
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
        this._headText = ''
        this._render(resource, head, [])
        this.closePeek()
        return
      }
      this._headText = head
      const regions = computeDirtyDiffRegions(head, model.getValue())
      this._render(resource, head, regions)
      if (this._controller?.isOpen) this._controller.refresh(regions, head)
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
    this._regions = regions
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

  private _onMouseDown(e: monaco.editor.IEditorMouseEvent): void {
    this._mouseDownLine = undefined
    const m = MonacoLoader.peek()
    if (!m) return
    const target = e.target
    if (target.type !== m.editor.MouseTargetType.GUTTER_LINE_DECORATIONS) return
    const el = target.element
    if (!el || el.className.indexOf('dirty-diff-gutter') < 0) return
    const line = target.position?.lineNumber
    if (line === undefined) return
    this._mouseDownLine = line
  }

  private _onMouseUp(e: monaco.editor.IEditorMouseEvent): void {
    const downLine = this._mouseDownLine
    this._mouseDownLine = undefined
    if (downLine === undefined) return
    const line = e.target.position?.lineNumber
    if (line === undefined || line !== downLine) return

    const index = this._regions.findIndex((r) => r.startLine <= line && r.endLine >= line)
    if (index === -1) return

    // Clicking the change whose peek is already open toggles it closed (VSCode).
    if (this._controller?.isOpen && this._controller.index === index) {
      this.closePeek()
      return
    }
    this._openPeekAtIndex(index)
  }

  private _openPeekAtIndex(index: number): boolean {
    if (!this._controller) return false
    this._controller.show(this._regions, index, this._headText)
    this._peekVisible.set(this._controller.isOpen)
    return this._controller.isOpen
  }

  // -- IDirtyDiffPeekHost (Esc keybinding / "show change" command / E2E probe) --

  /**
   * Open (or move) the peek to the change containing `line`; if none contains it,
   * the first change at or after `line`, else the last — mirroring VSCode's
   * "show change at cursor".
   */
  openAtLine(line: number): boolean {
    if (this._regions.length === 0) return false
    let index = this._regions.findIndex((r) => r.startLine <= line && r.endLine >= line)
    if (index === -1) index = this._regions.findIndex((r) => r.startLine >= line)
    if (index === -1) index = this._regions.length - 1
    return this._openPeekAtIndex(index)
  }

  closePeek(): void {
    this._controller?.close()
    this._peekVisible.set(false)
  }

  isPeekOpen(): boolean {
    return this._controller?.isOpen ?? false
  }

  getPeekPanelHeightPx(): number | undefined {
    return this._controller?.panelHeightPx
  }

  getPeekMaxHeightPx(): number | undefined {
    return this._controller?.maxHeightPx
  }

  resizePeekByPx(deltaPx: number): number | undefined {
    return this._controller?.resizeByPx(deltaPx)
  }

  /** Restore a region's current lines to their HEAD content — undoable model edit. */
  private _revert(region: DirtyDiffRegion): void {
    const editor = this._activeEditor
    const model = editor?.getModel()
    if (!editor || !model) return
    const m = MonacoLoader.get()

    const headLines =
      region.originalEndLine < region.originalStartLine
        ? []
        : this._headText
            .replace(/\r\n/g, '\n')
            .split('\n')
            .slice(region.originalStartLine - 1, region.originalEndLine)
    const replacement = headLines.join('\n')
    const lineCount = model.getLineCount()

    let range: monaco.Range
    let text: string
    if (region.kind === 'deleted') {
      // Re-insert the removed HEAD lines after the anchor line (or at the top of
      // the file when the deletion was the original first line).
      const atTop = region.originalStartLine === 1
      if (atTop) {
        range = new m.Range(1, 1, 1, 1)
        text = `${replacement}\n`
      } else {
        const anchor = region.startLine
        range = new m.Range(
          anchor,
          model.getLineMaxColumn(anchor),
          anchor,
          model.getLineMaxColumn(anchor),
        )
        text = `\n${replacement}`
      }
    } else if (region.endLine < lineCount) {
      range = new m.Range(region.startLine, 1, region.endLine + 1, 1)
      text = replacement === '' ? '' : `${replacement}\n`
    } else {
      range = new m.Range(
        region.startLine,
        1,
        region.endLine,
        model.getLineMaxColumn(region.endLine),
      )
      text = replacement
    }

    editor.pushUndoStop()
    editor.executeEdits('dirtyDiff.revert', [{ range, text, forceMoveMarkers: true }])
    editor.pushUndoStop()
    this.closePeek()
  }

  private async _stage(region: DirtyDiffRegion): Promise<void> {
    const path = this._activePath
    if (!path) return
    // Persist edits to disk first: stage-hunk diffs the index against the
    // working-tree FILE, so unsaved buffer changes would be invisible to git.
    await this._commandService.executeCommand('workbench.action.files.save').catch(() => undefined)
    await this._commandService
      .executeCommand(DirtyDiffCommands.stageChange, path, region.startLine, region.endLine)
      .catch(() => undefined)
    this.closePeek()
  }

  private async _openChanges(): Promise<void> {
    await this._commandService
      .executeCommand('git.openChange', undefined, { pinned: true })
      .catch(() => undefined)
  }

  private _clear(): void {
    this._navigation.setState({ resource: undefined, headContent: undefined, regions: [] })
    this._regions = []
    this._headText = ''
    this._mouseDownLine = undefined
    this._peekVisible.set(false)
    this._editorStore.clear()
    this._registryStore.clear()
    this._decorations?.clear()
    this._decorations = undefined
    this._activeEditor = undefined
    this._activeResource = undefined
    this._activePath = undefined
    this._controller = undefined
  }
}
