/*---------------------------------------------------------------------------------------------
 *  Tests for MainThreadCommands: runtime command registration forwarded from the
 *  extension host, and that those registrations don't leak (the registration
 *  disposables must parent through the instance, not sit orphaned in a plain Map).
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CommandsRegistry,
  DisposableStore,
  DisposableTracker,
  markAsSingleton,
  setDisposableTracker,
  type ICommandService,
} from '@universe-editor/platform'
import { type IExtHostCommands } from '@universe-editor/extensions-common'
import { MainThreadCommands } from '../MainThreadCommands.js'

function fakeExtHost(): { service: IExtHostCommands; exec: ReturnType<typeof vi.fn> } {
  const exec = vi.fn().mockResolvedValue(undefined)
  return { service: { $executeContributedCommand: exec } as IExtHostCommands, exec }
}

describe('MainThreadCommands', () => {
  afterEach(() => setDisposableTracker(null))

  it('registers a runtime command that forwards execution to the host', async () => {
    const ext = fakeExtHost()
    const mt = new MainThreadCommands(ext.service, {} as ICommandService)
    await mt.$registerCommand('ext.greet')
    expect(CommandsRegistry.getCommand('ext.greet')).toBeDefined()
    await CommandsRegistry.getCommand('ext.greet')!.handler({} as never, 1, 2)
    expect(ext.exec).toHaveBeenCalledWith('ext.greet', [1, 2])
    mt.dispose()
    expect(CommandsRegistry.getCommand('ext.greet')).toBeUndefined()
  })

  it('$unregisterCommand removes the registration', async () => {
    const mt = new MainThreadCommands(fakeExtHost().service, {} as ICommandService)
    await mt.$registerCommand('ext.bye')
    await mt.$unregisterCommand('ext.bye')
    expect(CommandsRegistry.getCommand('ext.bye')).toBeUndefined()
    mt.dispose()
  })

  it('runtime registrations do not leak under a singleton root', async () => {
    const tracker = new DisposableTracker()
    setDisposableTracker(tracker)
    const root = markAsSingleton(new DisposableStore())
    const mt = root.add(new MainThreadCommands(fakeExtHost().service, {} as ICommandService))
    // Register several commands and DON'T dispose — mirrors the extension host living
    // under workbenchStore at shutdown. A plain Map would orphan each registration.
    await mt.$registerCommand('ext.a')
    await mt.$registerCommand('ext.b')
    await mt.$registerCommand('ext.c')
    expect(tracker.computeLeakingDisposables()).toBeUndefined()
    // Clean up the global CommandsRegistry so other tests aren't polluted.
    root.dispose()
  })
})
