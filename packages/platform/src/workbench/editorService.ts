/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Inspired by VSCode's IEditorService / IEditorGroupsService.
 *--------------------------------------------------------------------------------------------*/

import type { IObservable } from '../base/observable/index.js'
import { Emitter, Event } from '../base/event.js'
import { Disposable, IDisposable, toDisposable } from '../base/lifecycle.js'
import { createDecorator } from '../di/instantiation.js'
import { URI } from '../base/uri.js'

// -------- IEditorInput (legacy structural type, kept for backwards compatibility) --------

export interface IEditorInput {
  readonly id: string
  /** Matches a registered IEditorProvider typeId. */
  readonly type: string
  readonly label: string
  isDirty: boolean
  /** Arbitrary metadata the editor provider may store. */
  readonly meta?: Record<string, unknown>
}

// -------- EditorInput (abstract base class) --------

/**
 * Abstract base class for editor inputs. Subclass and provide `typeId`,
 * `resource`, and `getName()`. Existing `IEditorInput` structural consumers
 * (`id` / `type` / `label`) keep working via the getters below.
 */
export abstract class EditorInput extends Disposable implements IEditorInput {
  abstract get typeId(): string
  abstract get resource(): URI | undefined
  abstract getName(): string

  /** Stable identity. Derived from `resource` when available, otherwise from typeId. */
  get id(): string {
    return this.resource?.toString() ?? `${this.typeId}:anonymous`
  }

  /** Legacy alias for `typeId`. */
  get type(): string {
    return this.typeId
  }

  /** Legacy alias for `getName()`. */
  get label(): string {
    return this.getName()
  }

  private _isDirty = false
  get isDirty(): boolean {
    return this._isDirty
  }
  set isDirty(value: boolean) {
    this.setDirty(value)
  }

  readonly meta?: Record<string, unknown> = undefined

  protected readonly _onDidChangeDirty = this._register(new Emitter<void>())
  readonly onDidChangeDirty: Event<void> = this._onDidChangeDirty.event

  protected readonly _onDidChangeLabel = this._register(new Emitter<void>())
  readonly onDidChangeLabel: Event<void> = this._onDidChangeLabel.event

  protected readonly _onWillDispose = this._register(new Emitter<void>())
  readonly onWillDispose: Event<void> = this._onWillDispose.event

  setDirty(value: boolean): void {
    if (this._isDirty === value) return
    this._isDirty = value
    this._onDidChangeDirty.fire()
  }

  /**
   * Equality by stable identity. Two inputs match when they share the same
   * resource URI, or when their `id`s are equal. Subclasses can override
   * for richer semantics (e.g. side-by-side editors).
   */
  matches(other: EditorInput | IEditorInput): boolean {
    if (this === other) return true
    if (other instanceof EditorInput) {
      if (this.resource && other.resource) {
        return this.resource.toString() === other.resource.toString()
      }
    }
    return this.id === other.id
  }

  private _disposed = false
  override dispose(): void {
    if (this._disposed) return
    this._disposed = true
    this._onWillDispose.fire()
    super.dispose()
  }

  get isDisposed(): boolean {
    return this._disposed
  }
}

// -------- IEditorProvider / IEditorRegistry --------

export interface IEditorProvider {
  /** Must match IEditorInput.type for all inputs this provider handles. */
  readonly typeId: string
  /**
   * Serialisable key used to look up the React component in the renderer.
   * The renderer maintains a `editorComponentMap` keyed by this value.
   */
  readonly componentKey: string
}

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
