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
  ILoggerService,
  makeGlobMatcher,
  NullLogger,
  URI,
  type EditorInput,
  type IDisposable,
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

  constructor(
    @IInstantiationService private readonly _inst: IInstantiationService,
    @IEditorService private readonly _editor: IEditorService,
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
    } else {
      chosen = candidates[0]
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
