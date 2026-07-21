/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  Renderer-side registry mapping IEditorProvider.componentKey -> React component.
 *  Lives in the renderer (platform must stay React/DOM-free); the platform-side
 *  EditorRegistry only stores the string componentKey, which this registry
 *  resolves at render time. Mirrors ViewComponentRegistry's singleton style.
 *--------------------------------------------------------------------------------------------*/

import type { ComponentType } from 'react'
import {
  IDisposable,
  IEditorInput,
  IEditorProvider,
  EditorRegistry,
  combinedDisposable,
  toDisposable,
} from '@universe-editor/platform'

export type EditorComponent = ComponentType<{ input: IEditorInput }>

export interface IEditorComponentRegistry {
  register(componentKey: string, component: EditorComponent): IDisposable
  get(componentKey: string): EditorComponent | undefined
}

class EditorComponentRegistryImpl implements IEditorComponentRegistry {
  private readonly _components = new Map<string, EditorComponent>()

  register(componentKey: string, component: EditorComponent): IDisposable {
    this._components.set(componentKey, component)
    return toDisposable(() => {
      if (this._components.get(componentKey) === component) {
        this._components.delete(componentKey)
      }
    })
  }

  get(componentKey: string): EditorComponent | undefined {
    return this._components.get(componentKey)
  }
}

export const EditorComponentRegistry: IEditorComponentRegistry = new EditorComponentRegistryImpl()

/**
 * An editor provider minus the renderer-only componentKey (derived from
 * `typeId`). `componentKey` may still be supplied to intentionally share one
 * React component across several editor types (e.g. untitled + schemaViewer
 * both render with the file editor).
 */
export type EditorRegistration = Omit<IEditorProvider, 'componentKey'> & {
  readonly componentKey?: string
}

/**
 * Single-point editor registration: declares the provider (deserialize hook +
 * typeId) and binds its React component together, deriving a stable
 * componentKey from `typeId` unless one is given explicitly. This removes the
 * cross-file hardcoded-string coupling of the old two-places-to-edit flow
 * (provider descriptor in a BlockStartup contribution + editorComponentMap in
 * EditorArea). Extensions may still use the lower-level EditorRegistry +
 * EditorComponentRegistry directly.
 */
export function registerEditorWithComponent(
  registration: EditorRegistration,
  component: EditorComponent,
): IDisposable {
  const componentKey = registration.componentKey ?? registration.typeId
  return combinedDisposable(
    EditorRegistry.registerEditorProvider({ ...registration, componentKey }),
    EditorComponentRegistry.register(componentKey, component),
  )
}
