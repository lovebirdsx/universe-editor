/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  monacoHoverDelegateGuard — diff editors wedge monaco's global hover-delegate
 *  factory onto a disposed child IInstantiationService; see below.
 *--------------------------------------------------------------------------------------------*/

import { onUnexpectedError, type IDisposable } from '@universe-editor/platform'

// ---------------------------------------------------------------------------
// Why this exists (monaco-editor 0.55.1)
//
// `vs/base/browser/ui/hover/hoverDelegateFactory.js` keeps ONE module-level
// `hoverDelegateFactory`; every `StandaloneCodeEditor` constructor overwrites
// it via `setHoverDelegateFactory(...)` with a closure capturing the
// `IInstantiationService` it was built with
// (`vs/editor/standalone/browser/standaloneCodeEditor.js`). Plain
// `editor.create` editors get the process-level root (never disposed), so the
// factory they install stays valid forever.
//
// `createDiffEditor` is different: `DiffEditorWidget` builds a per-widget
// `createChild` instantiation service (`vs/editor/browser/widget/diffEditor/
// diffEditorWidget.js`) and the two inner `StandaloneCodeEditor`s are built
// from that CHILD — so a diff editor installs a global factory capturing a
// child that is `_register`ed and disposed together with the widget. The
// factory is not reset on dispose, so it dangles. Afterwards ANY context menu
// (Menu → ActionBar → `createInstantHoverDelegate()`) or hover in ANY editor
// calls `createInstance` on the dead child and throws
// "InstantiationService has been disposed" — which is what the Output panel
// right-click was hitting.
//
// The guard below reseats the global factory onto a root-captured version
// whenever a tracked editor is torn down — on the editor's own onDidDispose
// AND when the tracker handle is disposed, since call sites order the two
// disposals differently — so a dangling diff-editor factory never survives
// its widget. It never disposes the delegate the factory returns (same
// ownership as monaco's own factory: the ActionBar registers it via
// `_register`).
// ---------------------------------------------------------------------------

interface IWorkbenchHoverDelegateCtor {
  new (
    placement: 'mouse' | 'element',
    hoverOptions: { instantHover: boolean },
    overrideOptions: Record<string, never>,
    ...services: unknown[]
  ): IDisposable
}

interface IHoverDelegateFactoryModule {
  setHoverDelegateFactory(
    factory: (placement: 'mouse' | 'element', enableInstantHover: boolean) => IDisposable,
  ): void
}

interface IHoverModule {
  WorkbenchHoverDelegate: IWorkbenchHoverDelegateCtor
}

/** Same shape as monaco's IInstantiationService for the one call we make. */
export interface IMonacoInstantiationServiceLike {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  createInstance(ctor: any, ...args: any[]): IDisposable
}

let _rootInstantiationService: IMonacoInstantiationServiceLike | undefined
let _hoverDelegateFactoryModule: IHoverDelegateFactoryModule | undefined
let _hoverModule: IHoverModule | undefined

/**
 * Capture the process-level root IInstantiationService (from
 * `StandaloneServices.initialize(...)`, never disposed) and pre-load the two
 * monaco modules needed to reseat the factory. Called once from
 * `MonacoLoader.loadMonaco()` right after initialize.
 */
export async function initHoverDelegateGuard(root: IMonacoInstantiationServiceLike): Promise<void> {
  _rootInstantiationService = root
  const [factoryMod, hoverMod] = await Promise.all([
    import('monaco-editor/esm/vs/base/browser/ui/hover/hoverDelegateFactory.js'),
    import('monaco-editor/esm/vs/platform/hover/browser/hover.js'),
  ])
  _hoverDelegateFactoryModule = factoryMod as unknown as IHoverDelegateFactoryModule
  _hoverModule = hoverMod as unknown as IHoverModule
}

/** Test seam — clear all captured state between tests. */
export function _resetHoverDelegateGuardForTests(): void {
  _rootInstantiationService = undefined
  _hoverDelegateFactoryModule = undefined
  _hoverModule = undefined
}

function installRootHoverDelegateFactory(): void {
  const root = _rootInstantiationService
  const factoryMod = _hoverDelegateFactoryModule
  const hoverMod = _hoverModule
  if (!root || !factoryMod || !hoverMod) return
  factoryMod.setHoverDelegateFactory((placement, enableInstantHover) =>
    root.createInstance(
      hoverMod.WorkbenchHoverDelegate,
      placement,
      { instantHover: enableInstantHover },
      {},
    ),
  )
}

/** Reseat the global hover-delegate factory onto the root service, if loaded. */
export function resetHoverDelegateFactoryToRoot(): void {
  try {
    installRootHoverDelegateFactory()
  } catch (err) {
    onUnexpectedError(err)
  }
}

/**
 * Track an editor so its teardown reseats the global hover-delegate factory
 * back to a root-captured one. Wire every `editor.create` / `createDiffEditor`
 * result through this; the reset is a no-op when the factory already points at
 * a live (root) service, so plain editors pay nothing.
 *
 * The reset runs BOTH on `onDidDispose` and when the returned disposable is
 * disposed: call sites tear down the guard and the editor in either order
 * (React cleanups dispose the guard first; DisposableStore clears in insertion
 * order), and both disposals happen exactly once per teardown, so hooking only
 * `onDidDispose` would let the factory dangle whenever the guard went first.
 * The reset is idempotent, so firing it twice is harmless.
 */
export function trackEditorDisposeForHoverGuard(editor: {
  onDidDispose(cb: () => void): IDisposable
}): IDisposable {
  const sub = editor.onDidDispose(() => resetHoverDelegateFactoryToRoot())
  return {
    dispose: () => {
      sub.dispose()
      resetHoverDelegateFactoryToRoot()
    },
  }
}
