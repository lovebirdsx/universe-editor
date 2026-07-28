/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Regression for the Output-panel right-click crash
 *  "InstantiationService has been disposed": a diff editor installs monaco's
 *  global hover-delegate factory with a closure over its per-widget child
 *  IInstantiationService and never resets it on dispose, so any later context
 *  menu (Menu → ActionBar → createInstantHoverDelegate) called createInstance
 *  on the dead child. trackEditorDisposeForHoverGuard() reseats the factory
 *  onto the never-disposed root service when the editor is disposed.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Emitter } from '@universe-editor/platform'

const rec = vi.hoisted(() => ({
  installedFactory: undefined as unknown,
}))

vi.mock('monaco-editor/esm/vs/base/browser/ui/hover/hoverDelegateFactory.js', () => ({
  setHoverDelegateFactory: (factory: unknown) => {
    rec.installedFactory = factory
  },
}))

vi.mock('monaco-editor/esm/vs/platform/hover/browser/hover.js', () => ({
  WorkbenchHoverDelegate: class WorkbenchHoverDelegate {
    constructor(
      public placement: string,
      public hoverOptions: unknown,
      public overrideOptions: unknown,
    ) {}
    dispose(): void {}
  },
}))

import {
  _resetHoverDelegateGuardForTests,
  initHoverDelegateGuard,
  trackEditorDisposeForHoverGuard,
} from '../monacoHoverDelegateGuard.js'

function makeFakeEditor() {
  const onDidDispose = new Emitter<void>()
  return {
    onDidDispose: onDidDispose.event,
    fireDispose: () => onDidDispose.fire(),
  }
}

function makeRoot(calls: { createInstance: number }) {
  return {
    createInstance: (ctor: new (...args: unknown[]) => unknown, ...args: unknown[]) => {
      calls.createInstance++
      return new ctor(...args) as { dispose(): void }
    },
  }
}

afterEach(() => {
  _resetHoverDelegateGuardForTests()
  rec.installedFactory = undefined
})

describe('monacoHoverDelegateGuard', () => {
  it('reseats the global hover-delegate factory onto the root service on editor dispose', async () => {
    const calls = { createInstance: 0 }
    await initHoverDelegateGuard(makeRoot(calls))
    const editor = makeFakeEditor()
    trackEditorDisposeForHoverGuard(editor)

    editor.fireDispose()

    const factory = rec.installedFactory as
      | ((placement: string, instant: boolean) => unknown)
      | undefined
    expect(factory).toBeTypeOf('function')
    // The installed factory must build the delegate through the root service.
    const delegate = factory!('element', true) as { placement: string; hoverOptions: unknown }
    expect(calls.createInstance).toBe(1)
    expect(delegate.placement).toBe('element')
    expect(delegate.hoverOptions).toEqual({ instantHover: true })
  })

  it('replaces a dangling factory left by a previous editor', async () => {
    await initHoverDelegateGuard(makeRoot({ createInstance: 0 }))
    // Simulate the stale factory a disposed diff editor left behind.
    rec.installedFactory = () => {
      throw new Error('InstantiationService has been disposed')
    }

    const editor = makeFakeEditor()
    trackEditorDisposeForHoverGuard(editor)
    editor.fireDispose()

    expect(() =>
      (rec.installedFactory as (p: string, i: boolean) => unknown)('element', true),
    ).not.toThrow()
  })

  it('reseats the factory when the tracker handle is disposed before the editor', async () => {
    // Production teardown order (React cleanups, DisposableStore.clear):
    // the guard goes first, the editor second. The reset must still happen —
    // this is the wiring the Output-panel right-click crash came from.
    await initHoverDelegateGuard(makeRoot({ createInstance: 0 }))
    rec.installedFactory = () => {
      throw new Error('InstantiationService has been disposed')
    }

    const editor = makeFakeEditor()
    const sub = trackEditorDisposeForHoverGuard(editor)
    sub.dispose()
    editor.fireDispose()

    expect(() =>
      (rec.installedFactory as (p: string, i: boolean) => unknown)('element', true),
    ).not.toThrow()
  })

  it('reseats exactly once per teardown even when both disposals fire', async () => {
    const calls = { createInstance: 0 }
    await initHoverDelegateGuard(makeRoot(calls))
    const editor = makeFakeEditor()
    const sub = trackEditorDisposeForHoverGuard(editor)

    editor.fireDispose()
    sub.dispose()

    const factory = rec.installedFactory as (p: string, i: boolean) => unknown
    factory('element', true)
    expect(calls.createInstance).toBe(1)
  })

  it('dispose is a no-op before initHoverDelegateGuard captured the modules', () => {
    _resetHoverDelegateGuardForTests()
    expect(() => makeFakeEditor().fireDispose()).not.toThrow()
    expect(rec.installedFactory).toBeUndefined()
  })
})
