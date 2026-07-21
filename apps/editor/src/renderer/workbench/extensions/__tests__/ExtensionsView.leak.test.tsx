/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Regression: ExtensionsView subscribes to IExtensionsWorkbenchService.onDidChange
 *  through useEventValue. That subscription must be markAsSingleton-wrapped so the
 *  Restart-Editor leak snapshot (taken with React still mounted, before passive
 *  cleanup flushes) does not flag it — while a real unmount still disposes it.
 *
 *  Doubles as the guardrail template for components migrated off hand-rolled
 *  `useEffect` + `.onDid*()` onto useEventValue / useEventSubscription.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import {
  DisposableTracker,
  Emitter,
  IEditorService,
  INotificationService,
  InstantiationService,
  ServiceCollection,
  setDisposableTracker,
  toDisposable,
  type IEditorService as IEditorServiceType,
  type INotificationService as INotificationServiceType,
} from '@universe-editor/platform'
import { ExtensionsView } from '../ExtensionsView.js'
import { IExtensionsWorkbenchService } from '../../../services/extensionsWorkbench/ExtensionsWorkbenchService.js'
import { ServicesContext } from '../../useService.js'

afterEach(() => {
  cleanup()
  setDisposableTracker(null)
})

function setup() {
  const onDidChange = new Emitter<void>()
  let subscriptionDisposed = false
  const workbench = {
    _serviceBrand: undefined,
    // Wrap the real emitter event so we can observe teardown.
    onDidChange: (listener: () => unknown) => {
      const d = onDidChange.event(listener)
      return toDisposable(() => {
        subscriptionDisposed = true
        d.dispose()
      })
    },
    isMarketplaceEnabled: vi.fn(async () => false),
    getInstalled: vi.fn(() => []),
    getSearchResults: vi.fn(() => []),
    searchText: '',
    searching: false,
    search: vi.fn(async () => undefined),
    loadFeatured: vi.fn(async () => undefined),
    refreshInstalled: vi.fn(async () => undefined),
    install: vi.fn(async () => undefined),
    installVSIX: vi.fn(async () => undefined),
    uninstall: vi.fn(async () => undefined),
    setEnablement: vi.fn(async () => undefined),
    hasWorkspace: vi.fn(() => false),
    getReadme: vi.fn(async () => ''),
    getIcon: vi.fn(async () => ''),
    find: vi.fn(() => undefined),
  }
  const services = new ServiceCollection()
  services.set(IExtensionsWorkbenchService, workbench as unknown as IExtensionsWorkbenchService)
  services.set(INotificationService, {
    _serviceBrand: undefined,
    notify: vi.fn(),
  } as unknown as INotificationServiceType)
  services.set(IEditorService, {
    _serviceBrand: undefined,
    openEditor: vi.fn(async () => undefined),
  } as unknown as IEditorServiceType)
  const inst = new InstantiationService(services)
  const { unmount } = render(
    <ServicesContext.Provider value={inst}>
      <ExtensionsView />
    </ServicesContext.Provider>,
  )
  return { unmount, isSubscriptionDisposed: () => subscriptionDisposed }
}

describe('ExtensionsView disposable hygiene', () => {
  it('does not report its onDidChange subscription as a leak while mounted', () => {
    const tracker = new DisposableTracker()
    setDisposableTracker(tracker)

    setup()

    const report = tracker.computeLeakingDisposables()
    // The useEventValue subscription must not surface; other view internals are
    // out of scope for this guardrail.
    expect(report?.details ?? '').not.toContain('useEventValue')
  })

  it('still disposes the subscription on unmount', () => {
    const { unmount, isSubscriptionDisposed } = setup()
    expect(isSubscriptionDisposed()).toBe(false)
    act(() => unmount())
    expect(isSubscriptionDisposed()).toBe(true)
  })
})
