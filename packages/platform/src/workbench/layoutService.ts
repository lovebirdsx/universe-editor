/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Inspired by VSCode's IWorkbenchLayoutService (workbench/services/layout/browser/layoutService.ts).
 *--------------------------------------------------------------------------------------------*/

import type { Event } from '../base/event.js'
import type { IDisposable } from '../base/lifecycle.js'
import type { IObservable } from '../base/observable/index.js'
import { createDecorator } from '../di/instantiation.js'
import type { IPart } from './part.js'

export const enum PartId {
  ActivityBar = 'activityBar',
  SideBar = 'sideBar',
  SecondarySideBar = 'secondarySideBar',
  EditorArea = 'editorArea',
  Panel = 'panel',
  StatusBar = 'statusBar',
}

export interface LayoutSizes {
  /** SideBar width in px (excludes ActivityBar). */
  sidebar: number
  /** SecondarySideBar width in px. */
  secondarySidebar: number
  /** Panel height in px. */
  panel: number
}

export interface IFocusPartOptions {
  /** Distinguishes call sites for telemetry / behaviour gating. */
  source?: 'user' | 'restore' | 'command'
  /** Override the default 2000ms whenMounted timeout. */
  timeoutMs?: number
}

export interface ILayoutService {
  readonly _serviceBrand: undefined

  getVisible(part: PartId): boolean
  setVisible(part: PartId, visible: boolean): void
  toggleVisible(part: PartId): void

  readonly visible: IObservable<Readonly<Record<PartId, boolean>>>

  /** Whether the Panel is maximized (editor area hidden, panel fills the center). */
  readonly panelMaximized: IObservable<boolean>
  setPanelMaximized(maximized: boolean): void
  togglePanelMaximized(): void

  readonly sizes: IObservable<Readonly<LayoutSizes>>
  setSize(key: keyof LayoutSizes, value: number): void

  /** Load persisted layout (visible + sizes) from storage. Safe to call when storage is unavailable. */
  load(): Promise<void>
  /** Synchronous default state so the workbench can mount before hydration. */
  loadDefaults(): void
  /** Read persisted layout from WORKSPACE scope (waits for hydration) and apply it. */
  reconcileFromStorage(): Promise<void>
  /** Force-flush any pending persist. */
  save(): Promise<void>

  // -- Part registry --------------------------------------------------------

  /**
   * Register a Part with the layout service. Each PartId may have at most one
   * registered Part at a time. The returned disposable removes the registration.
   */
  registerPart(part: IPart): IDisposable
  /** Lookup a registered Part by id. Returns undefined if none is registered. */
  getPart<T extends IPart = IPart>(id: PartId): T | undefined
  /** Snapshot of all currently-registered Parts. */
  getParts(): readonly IPart[]
  /** Fires when a Part has just been registered. */
  readonly onDidRegisterPart: Event<IPart>

  // -- Focus routing --------------------------------------------------------

  /**
   * Reveal `part` (making it visible if necessary), wait for it to mount, then
   * call `focus()` on it. Resolves to true on success, false on timeout / no
   * such part. Never throws.
   */
  focusPart(part: PartId, opts?: IFocusPartOptions): Promise<boolean>

  /**
   * Open the view container that hosts `viewId`, focus the hosting part, then
   * focus the view's registered focusable element (if any). Resolves to true
   * on success.
   */
  focusView(viewId: string, opts?: IFocusPartOptions): Promise<boolean>
}

export const ILayoutService = createDecorator<ILayoutService>('layoutService')
