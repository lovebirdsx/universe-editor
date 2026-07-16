/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  EditorResolverService — renderer-side implementation of IEditorResolverService.
 *  Matches a file URI against registered glob patterns and creates the appropriate
 *  EditorInput, allowing future editor types to be registered without platform changes.
 *--------------------------------------------------------------------------------------------*/

import {
  IEditorGroupsService,
  IEditorResolverService,
  IEditorService,
  IInstantiationService,
  ILoggerService,
  makeGlobMatcher,
  NullLogger,
  URI,
  type EditorInput,
  type IDisposable,
  type IEditorGroupsService as IEditorGroupsServiceType,
  type IEditorResolverInfo,
  type IEditorResolverRegistration,
  type ILogger,
  type ILoggerService as ILoggerServiceType,
} from '@universe-editor/platform'
import { FileEditorInput } from './FileEditorInput.js'

export class EditorResolverService implements IEditorResolverService {
  declare readonly _serviceBrand: undefined

  private readonly _regs: IEditorResolverRegistration[] = []
  private readonly _logger: ILogger
  /**
   * URIs the user explicitly reopened via "Reopen With..." (openEditor with a
   * `preferredTypeId`). These are never auto-upgraded when a higher-priority
   * editor registers later — the user's choice wins.
   */
  private readonly _explicitChoices = new Set<string>()

  constructor(
    @IInstantiationService private readonly _inst: IInstantiationService,
    @IEditorService private readonly _editor: IEditorService,
    @IEditorGroupsService private readonly _groups: IEditorGroupsServiceType,
    @ILoggerService loggerService: ILoggerServiceType,
  ) {
    this._logger =
      loggerService?.createLogger({ id: 'editorResolver', name: 'Editor Resolver' }) ??
      new NullLogger()
  }

  registerEditor(
    glob: string,
    info: IEditorResolverInfo,
    factory: (uri: URI) => EditorInput,
  ): IDisposable {
    const priority = info.priority ?? 1
    const fullInfo = { ...info, priority }

    const dup = this._regs.find((r) => r.info.typeId === fullInfo.typeId && r.glob === glob)
    if (dup) {
      this._logger.warn(`duplicate registration type=${info.typeId} glob=${glob}`)
      return { dispose: () => {} }
    }

    const reg: IEditorResolverRegistration = { glob, info: fullInfo, factory }
    this._regs.push(reg)
    this._logger.debug(`registerEditor type=${fullInfo.typeId} glob=${glob} priority=${priority}`)
    // Custom-editor bindings (e.g. the PDF viewer) register asynchronously, after
    // the extension host reports its contributions — so a matching file opened
    // during that startup window falls to the priority-1 catch-all FileEditorInput
    // and renders a binary as text (garbage). Re-open any such tab in place now
    // that a higher-priority editor for its URI exists.
    this._upgradeOpenEditors(reg)
    return {
      dispose: () => {
        const idx = this._regs.indexOf(reg)
        if (idx !== -1) {
          this._regs.splice(idx, 1)
          this._logger.debug(`disposeEditorRegistration type=${fullInfo.typeId} glob=${glob}`)
        }
      },
    }
  }

  /**
   * Re-open, in place, every already-open tab whose URI matches `reg`'s glob and
   * is currently shown by a lower-priority editor than `reg` — the self-heal for
   * the late-registration race described in `registerEditor`. Tabs the user
   * explicitly reopened (tracked in `_explicitChoices`) are left untouched.
   */
  private _upgradeOpenEditors(reg: IEditorResolverRegistration): void {
    const matcher = makeGlobMatcher([reg.glob])
    for (const group of this._groups.groups) {
      // Snapshot: closeEditor/openEditor below mutates group.editors mid-iteration.
      for (const editor of [...group.editors]) {
        const uri = editor.resource
        if (!uri) continue
        if (matcher !== null && !matcher(uri.path)) continue
        if (editor.typeId === reg.info.typeId) continue
        if (this._explicitChoices.has(uri.toString())) continue
        // Only upgrade — never replace a tab already showing an equal/higher-priority editor.
        if (reg.info.priority <= this._priorityOf(uri, editor.typeId)) continue

        const index = group.indexOf(editor)
        const wasActive = group.activeEditor === editor
        group.closeEditor(editor)
        group.openEditor(reg.factory(uri), {
          index,
          pinned: true,
          activate: wasActive,
          preserveFocus: !wasActive,
        })
        this._logger.info(
          `upgraded editor uri=${uri.toString()} ${editor.typeId} -> ${reg.info.typeId}`,
        )
      }
    }
  }

  /** Highest priority among registrations for `uri` whose typeId is `typeId` (0 if none). */
  private _priorityOf(uri: URI, typeId: string): number {
    let best = 0
    for (const r of this._regs) {
      if (r.info.typeId !== typeId) continue
      const matcher = makeGlobMatcher([r.glob])
      if (matcher === null || matcher(uri.path)) best = Math.max(best, r.info.priority)
    }
    return best
  }

  resolveEditors(uri: URI): IEditorResolverRegistration[] {
    return this._regs
      .filter((r) => {
        const matcher = makeGlobMatcher([r.glob])
        // matcher is null only when patterns is empty, which cannot happen here
        return matcher === null || matcher(uri.path)
      })
      .sort((a, b) => b.info.priority - a.info.priority)
  }

  async openEditor(
    uri: URI,
    options?: { preferredTypeId?: string; pinned?: boolean; preserveFocus?: boolean },
  ): Promise<void> {
    const candidates = this.resolveEditors(uri)

    let chosen: IEditorResolverRegistration | undefined
    if (options?.preferredTypeId) {
      chosen = candidates.find((r) => r.info.typeId === options.preferredTypeId) ?? candidates[0]
      // The user picked this editor type explicitly ("Reopen With..."). Remember
      // it so a later, higher-priority registration doesn't auto-upgrade the tab
      // out from under them.
      this._explicitChoices.add(uri.toString())
    } else {
      chosen = candidates[0]
      // A default open re-follows priority ordering; drop any stale explicit pin.
      this._explicitChoices.delete(uri.toString())
    }

    const input: EditorInput = chosen
      ? chosen.factory(uri)
      : this._inst.createInstance(FileEditorInput, uri)

    this._logger.info(
      `openEditor uri=${uri.toString()} chosen=${chosen?.info.typeId ?? 'default'} candidates=${candidates.length}`,
    )
    this._editor.openEditor(input, {
      pinned: options?.pinned ?? true,
      ...(options?.preserveFocus === true ? { preserveFocus: true } : {}),
    })
  }
}
