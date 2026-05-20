/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  EditorResolverService — renderer-side implementation of IEditorResolverService.
 *  Matches a file URI against registered glob patterns and creates the appropriate
 *  EditorInput, allowing future editor types to be registered without platform changes.
 *--------------------------------------------------------------------------------------------*/

import {
  IEditorResolverService,
  IEditorService,
  IInstantiationService,
  URI,
  type EditorInput,
  type IDisposable,
  type IEditorResolverInfo,
  type IEditorResolverRegistration,
} from '@universe-editor/platform'
import { makeGlobMatcher } from '../search/glob.js'
import { FileEditorInput } from './FileEditorInput.js'

export class EditorResolverService implements IEditorResolverService {
  declare readonly _serviceBrand: undefined

  private readonly _regs: IEditorResolverRegistration[] = []

  constructor(
    @IInstantiationService private readonly _inst: IInstantiationService,
    @IEditorService private readonly _editor: IEditorService,
  ) {}

  registerEditor(
    glob: string,
    info: IEditorResolverInfo,
    factory: (uri: URI) => EditorInput,
  ): IDisposable {
    const priority = info.priority ?? 1
    const fullInfo = { ...info, priority }

    const dup = this._regs.find((r) => r.info.typeId === fullInfo.typeId && r.glob === glob)
    if (dup) {
      console.warn(
        `EditorResolverService: duplicate registration (${info.typeId}, ${glob}) — skipped`,
      )
      return { dispose: () => {} }
    }

    const reg: IEditorResolverRegistration = { glob, info: fullInfo, factory }
    this._regs.push(reg)
    return {
      dispose: () => {
        const idx = this._regs.indexOf(reg)
        if (idx !== -1) this._regs.splice(idx, 1)
      },
    }
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
    options?: { preferredTypeId?: string; pinned?: boolean },
  ): Promise<void> {
    const candidates = this.resolveEditors(uri)

    let chosen: IEditorResolverRegistration | undefined
    if (options?.preferredTypeId) {
      chosen = candidates.find((r) => r.info.typeId === options.preferredTypeId) ?? candidates[0]
    } else {
      chosen = candidates[0]
    }

    const input: EditorInput = chosen
      ? chosen.factory(uri)
      : this._inst.createInstance(FileEditorInput, uri)

    this._editor.openEditor(input, { pinned: options?.pinned ?? true })
  }
}
