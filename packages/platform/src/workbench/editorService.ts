/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Inspired by VSCode's IEditorService / IEditorGroupsService.
 *--------------------------------------------------------------------------------------------*/

import type { Event } from '../base/event.js'
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

export interface IActiveEditorChangeEvent {
  readonly editor: IEditorInput | undefined
}

/**
 * Immutable snapshot of editor state. Returned by IEditorService.getSnapshot().
 *
 * Reference is stable when nothing changed — required for useSyncExternalStore
 * compatibility (see plan §11).
 */
export interface EditorState {
  readonly openEditors: readonly IEditorInput[]
  readonly activeEditorId: string | undefined
}

export interface IEditorService {
  readonly _serviceBrand: undefined

  openEditor(input: IEditorInput): void
  closeEditor(id: string): void
  closeAllEditors(): void

  /** Pull the current state. Reference is stable across calls when nothing changed. */
  getSnapshot(): EditorState
  /** Notified on every state change. Pair with getSnapshot for useSyncExternalStore. */
  subscribe(listener: () => void): IDisposable

  // Convenience getters (read through the same snapshot).
  readonly activeEditor: IEditorInput | undefined
  readonly openEditors: readonly IEditorInput[]

  // Legacy events kept for non-React consumers (commands, IPC, contributions).
  readonly onDidChangeActiveEditor: Event<IActiveEditorChangeEvent>
  readonly onDidOpenEditor: Event<IEditorInput>
  readonly onDidCloseEditor: Event<IEditorInput>
}

export const IEditorService = createDecorator<IEditorService>('editorService')
