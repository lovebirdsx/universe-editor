/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  Renderer-side registry mapping IStatusBarEntry.componentKey -> React component.
 *  Lives in the renderer (platform must stay React/DOM-free); the platform-side
 *  IStatusBarEntry only stores the string componentKey, which this registry
 *  resolves at render time. Mirrors ViewComponentRegistry's singleton + IDisposable
 *  registration style.
 *--------------------------------------------------------------------------------------------*/

import type { ComponentType } from 'react'
import { IDisposable, toDisposable, type IStatusBarEntry } from '@universe-editor/platform'

export interface StatusBarItemProps {
  entry: IStatusBarEntry
}

export interface IStatusBarComponentRegistry {
  register(componentKey: string, component: ComponentType<StatusBarItemProps>): IDisposable
  get(componentKey: string): ComponentType<StatusBarItemProps> | undefined
}

class StatusBarComponentRegistryImpl implements IStatusBarComponentRegistry {
  private readonly _components = new Map<string, ComponentType<StatusBarItemProps>>()

  register(componentKey: string, component: ComponentType<StatusBarItemProps>): IDisposable {
    this._components.set(componentKey, component)
    return toDisposable(() => {
      if (this._components.get(componentKey) === component) {
        this._components.delete(componentKey)
      }
    })
  }

  get(componentKey: string): ComponentType<StatusBarItemProps> | undefined {
    return this._components.get(componentKey)
  }
}

export const StatusBarComponentRegistry: IStatusBarComponentRegistry =
  new StatusBarComponentRegistryImpl()
