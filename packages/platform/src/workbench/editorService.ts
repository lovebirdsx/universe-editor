/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Inspired by VSCode's IEditorService / IEditorGroupsService.
 *--------------------------------------------------------------------------------------------*/

import type { IObservable } from '../base/observable/index.js'
import { Emitter, Event } from '../base/event.js'
import { Disposable, IDisposable, toDisposable } from '../base/lifecycle.js'
import { createDecorator } from '../di/instantiation.js'
import type { ServicesAccessor } from '../di/instantiation.js'
import type { IDialogService } from '../dialog/dialogService.js'
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
   * Persist the input's current contents. Inputs that wrap real resources
   * (e.g. files) implement this; virtual inputs (Welcome, Settings) leave it
   * undefined. Returns `true` on success, `false` on user cancel / failure.
   */
  save?(): Promise<boolean>

  /**
   * Discard in-memory edits and reload the underlying resource so that
   * `isDirty` returns to `false`. Optional, mirrors `save`.
   */
  revert?(): Promise<void>

  /**
   * Optional gate run before the editor is closed. Return `false` to abort the
   * close (user cancelled). Inputs without in-memory dirty state (e.g. agent
   * sessions) use this instead of `isDirty` to confirm destructive closes.
   */
  confirmClose?(dialogService: IDialogService): Promise<boolean>

  /**
   * Request focus for this input's mounted view. Non-Monaco editors (e.g.
   * React-based) implement this instead of registering with a Monaco registry.
   * Return true if focus was handled; undefined/false falls through to the
   * EditorArea container focus fallback.
   */
  focus?(): boolean

  /**
   * Returns a JSON-serialisable snapshot of this input for persistence.
   * `EditorGroupsService.toJSON` falls back to `null` when an input does not
   * implement this hook, preserving backwards compatibility with virtual
   * inputs that have no meaningful state.
   */
  serialize?(): unknown

  /**
   * Optional string icon id for the tab. When undefined the tab falls back to a
   * resource-derived file icon. Resolved to a concrete icon component by the
   * renderer, keeping the platform layer free of any icon-library dependency.
   */
  getIconId?(): string | undefined

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
  /**
   * Optional hydration hook used by EditorGroupsService.restore() to rebuild
   * EditorInputs from persisted JSON. Returns `null` if the data cannot be
   * deserialized (e.g. resource no longer exists); the restore pipeline skips
   * null entries rather than crashing.
   *
   * The optional `accessor` lets providers reach into DI (e.g. to obtain
   * `IInstantiationService.createInstance`) when constructing inputs that
   * require services.
   */
  deserialize?(data: unknown, accessor?: ServicesAccessor): EditorInput | null
}

export interface IEditorRegistry {
  registerEditorProvider(provider: IEditorProvider): IDisposable
  getProvider(typeId: string): IEditorProvider | undefined
  /**
   * Convenience wrapper around `getProvider(typeId)?.deserialize?.(data, accessor)`.
   * Returns null when no provider is registered or the provider lacks a
   * `deserialize` hook.
   */
  deserialize(typeId: string, data: unknown, accessor?: ServicesAccessor): EditorInput | null
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

  deserialize(typeId: string, data: unknown, accessor?: ServicesAccessor): EditorInput | null {
    const provider = this._providers.get(typeId)
    if (!provider || !provider.deserialize) return null
    try {
      return provider.deserialize(data, accessor)
    } catch {
      return null
    }
  }
}

export const EditorRegistry: IEditorRegistry = new EditorRegistryImpl()

// -------- IEditorService --------

export interface IOpenEditorServiceOptions {
  /** Activate the editor after opening (default: true). */
  activate?: boolean
  /** Pin the editor (default: true). false opens into the active group's preview slot. */
  pinned?: boolean
  /** Open without moving keyboard focus to the editor (default: false). */
  preserveFocus?: boolean
}

export interface IEditorService {
  readonly _serviceBrand: undefined

  openEditor(input: IEditorInput, options?: IOpenEditorServiceOptions): void
  closeEditor(id: string): void
  closeAllEditors(): void

  readonly openEditors: IObservable<readonly IEditorInput[]>
  readonly activeEditorId: IObservable<string | undefined>
  /** Derived: the currently active IEditorInput (undefined if none open). */
  readonly activeEditor: IObservable<IEditorInput | undefined>
}

export const IEditorService = createDecorator<IEditorService>('editorService')
