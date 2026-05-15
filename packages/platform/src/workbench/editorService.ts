/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Inspired by VSCode's IEditorService / IEditorGroupsService.
 *--------------------------------------------------------------------------------------------*/

import type { IObservable } from '../base/observable/index.js'
import { IDisposable, toDisposable } from '../base/lifecycle.js'
import { createDecorator } from '../di/instantiation.js'

export interface IEditorInput {
  readonly id: string
  /** Matches a registered IEditorProvider typeId. */
  readonly type: string
  readonly label: string
  isDirty: boolean
  /** Arbitrary metadata the editor provider may store. */
  readonly meta?: Record<string, unknown>
}

export interface IEditorProvider {
  /** Must match IEditorInput.type for all inputs this provider handles. */
  readonly typeId: string
  /**
   * Serialisable key used to look up the React component in the renderer.
   * The renderer maintains a `editorComponentMap` keyed by this value.
   */
  readonly componentKey: string
}

// -------- IEditorRegistry --------

export interface IEditorRegistry {
  registerEditorProvider(provider: IEditorProvider): IDisposable
  getProvider(typeId: string): IEditorProvider | undefined
}

class EditorRegistryImpl implements IEditorRegistry {
  private readonly _providers = new Map<string, IEditorProvider>()

  registerEditorProvider(provider: IEditorProvider): IDisposable {
    this._providers.set(provider.typeId, provider)
    return toDisposable(() => this._providers.delete(provider.typeId))
  }

  getProvider(typeId: string): IEditorProvider | undefined {
    return this._providers.get(typeId)
  }
}

export const EditorRegistry: IEditorRegistry = new EditorRegistryImpl()

// -------- IEditorService --------

export interface IEditorService {
  readonly _serviceBrand: undefined

  openEditor(input: IEditorInput): void
  closeEditor(id: string): void
  closeAllEditors(): void

  readonly openEditors: IObservable<readonly IEditorInput[]>
  readonly activeEditorId: IObservable<string | undefined>
  /** Derived: the currently active IEditorInput (undefined if none open). */
  readonly activeEditor: IObservable<IEditorInput | undefined>
}

export const IEditorService = createDecorator<IEditorService>('editorService')
