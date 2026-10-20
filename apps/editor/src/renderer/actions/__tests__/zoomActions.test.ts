/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Tests for the window zoom commands: keybinding + menu wiring and that each
 *  action delegates to the matching IHostService method.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CommandsRegistry,
  Emitter,
  IHostService,
  InstantiationService,
  KeybindingsRegistry,
  MenuId,
  MenuRegistry,
  ServiceCollection,
  registerAction2,
  type IDisposable,
  type IHostService as IHostServiceType,
} from '@universe-editor/platform'
import { ResetZoomAction, ZoomInAction, ZoomOutAction } from '../zoomActions.js'
import { IWorkbenchWindowService } from '../../services/windows/workbenchWindowService.js'
import { IAuxiliaryEditorWindowService } from '../../services/windows/auxiliaryEditorWindowService.js'

function mainWindowService(): never {
  return { activeWindow: { isMain: true, token: undefined } } as never
}

function makeHostStub(): IHostServiceType & {
  zoomIn: ReturnType<typeof vi.fn>
  zoomOut: ReturnType<typeof vi.fn>
  resetZoom: ReturnType<typeof vi.fn>
} {
  const emitter = new Emitter<boolean>()
  return {
    _serviceBrand: undefined,
    platform: 'win32',
    onDidChangeMaximized: emitter.event,
    isMaximized: () => Promise.resolve(false),
    minimizeWindow: () => Promise.resolve(),
    toggleMaximizeWindow: () => Promise.resolve(),
    closeWindow: () => Promise.resolve(),
    restart: () => Promise.resolve(),
    toggleDevTools: () => Promise.resolve(),
    zoomIn: vi.fn().mockResolvedValue(undefined),
    zoomOut: vi.fn().mockResolvedValue(undefined),
    resetZoom: vi.fn().mockResolvedValue(undefined),
  } as never
}

function runCommand(
  commandId: string,
  host: IHostServiceType,
  overrides: {
    windows?: unknown
    auxiliary?: unknown
  } = {},
): Promise<unknown> {
  const services = new ServiceCollection()
  services.set(IHostService, host)
  services.set(IWorkbenchWindowService, (overrides.windows ?? mainWindowService()) as never)
  if (overrides.auxiliary) {
    services.set(IAuxiliaryEditorWindowService, overrides.auxiliary as never)
  }
  const inst = new InstantiationService(services)
  return inst.invokeFunction((accessor) => {
    const cmd = CommandsRegistry.getCommand(commandId)!
    return cmd.handler(accessor) as unknown as Promise<void>
  })
}

describe('zoomActions', () => {
  const disposables: IDisposable[] = []
  afterEach(() => {
    while (disposables.length > 0) disposables.pop()?.dispose()
  })

  it('registers the three zoom commands with keybindings + View menu wiring', () => {
    disposables.push(registerAction2(ZoomInAction))
    disposables.push(registerAction2(ZoomOutAction))
    disposables.push(registerAction2(ResetZoomAction))

    expect(KeybindingsRegistry.resolveKeybinding('ctrl+=')).toBe(ZoomInAction.ID)
    expect(KeybindingsRegistry.resolveKeybinding('ctrl+-')).toBe(ZoomOutAction.ID)
    expect(KeybindingsRegistry.resolveKeybinding('ctrl+0')).toBe(ResetZoomAction.ID)

    for (const id of [ZoomInAction.ID, ZoomOutAction.ID, ResetZoomAction.ID]) {
      expect(
        MenuRegistry.getMenuItems(MenuId.MenubarViewMenu).some(
          (i) => 'command' in i && i.command === id,
        ),
      ).toBe(true)
    }
  })

  it('each action delegates to its IHostService method', async () => {
    disposables.push(registerAction2(ZoomInAction))
    disposables.push(registerAction2(ZoomOutAction))
    disposables.push(registerAction2(ResetZoomAction))
    const host = makeHostStub()

    await runCommand(ZoomInAction.ID, host)
    await runCommand(ZoomOutAction.ID, host)
    await runCommand(ResetZoomAction.ID, host)

    expect(host.zoomIn).toHaveBeenCalledTimes(1)
    expect(host.zoomOut).toHaveBeenCalledTimes(1)
    expect(host.resetZoom).toHaveBeenCalledTimes(1)
  })

  it('routes zoom to the focused auxiliary window instead of the main webContents', async () => {
    disposables.push(registerAction2(ZoomInAction))
    disposables.push(registerAction2(ZoomOutAction))
    disposables.push(registerAction2(ResetZoomAction))
    const host = makeHostStub()
    const auxiliary = {
      getWindowForToken: vi.fn(() => ({ token: 'aux-1' })),
      zoomIn: vi.fn().mockResolvedValue(undefined),
      zoomOut: vi.fn().mockResolvedValue(undefined),
      resetZoom: vi.fn().mockResolvedValue(undefined),
    }
    const windows = { activeWindow: { isMain: false, token: 'aux-1' } }

    await runCommand(ZoomInAction.ID, host, { windows, auxiliary })
    await runCommand(ZoomOutAction.ID, host, { windows, auxiliary })
    await runCommand(ResetZoomAction.ID, host, { windows, auxiliary })

    expect(auxiliary.zoomIn).toHaveBeenCalledTimes(1)
    expect(auxiliary.zoomOut).toHaveBeenCalledTimes(1)
    expect(auxiliary.resetZoom).toHaveBeenCalledTimes(1)
    expect(host.zoomIn).not.toHaveBeenCalled()
    expect(host.zoomOut).not.toHaveBeenCalled()
    expect(host.resetZoom).not.toHaveBeenCalled()
  })
})
