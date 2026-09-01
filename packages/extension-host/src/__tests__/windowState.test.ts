import { describe, expect, it, vi } from 'vitest'
import type {
  IMainThreadCommands,
  IMainThreadScm,
  IMainThreadTimeline,
  IMainThreadWindow,
} from '@universe-editor/extensions-common'
import type { WindowState } from '@universe-editor/extension-api'
import { ExtensionService } from '../extensionService.js'

const noopCommands: IMainThreadCommands = {
  $registerCommand: () => Promise.resolve(),
  $unregisterCommand: () => Promise.resolve(),
  $getCommands: () => Promise.resolve([]),
  $executeCommand: () => Promise.resolve(undefined),
}

const noopWindow: IMainThreadWindow = {
  $showMessage: () => Promise.resolve(undefined),
  $showQuickPick: () => Promise.resolve(undefined),
  $showInputBox: () => Promise.resolve(undefined),
  $setStatusBarEntry: () => Promise.resolve(),
  $disposeStatusBarEntry: () => Promise.resolve(),
  $clipboardReadText: () => Promise.resolve(''),
  $clipboardWriteText: () => Promise.resolve(),
  $openExternal: () => Promise.resolve(false),
  $startProgress: () => Promise.resolve(),
  $reportProgress: () => Promise.resolve(),
  $endProgress: () => Promise.resolve(),
  $showOpenDialog: () => Promise.resolve(undefined),
  $showSaveDialog: () => Promise.resolve(undefined),
}

const noopScm: IMainThreadScm = {
  $registerSourceControl: () => Promise.resolve(),
  $updateSourceControl: () => Promise.resolve(),
  $unregisterSourceControl: () => Promise.resolve(),
  $registerGroup: () => Promise.resolve(),
  $updateGroup: () => Promise.resolve(),
  $updateGroupResourceStates: () => Promise.resolve(),
  $updateSupplementaryDecorations: () => Promise.resolve(),
  $publishWorkingTreeScan: () => Promise.resolve(),
  $unregisterGroup: () => Promise.resolve(),
  $setInputBoxValue: () => Promise.resolve(),
  $setInputBoxPlaceholder: () => Promise.resolve(),
}

const noopTimeline: IMainThreadTimeline = {
  $registerTimelineProvider: () => Promise.resolve(),
  $unregisterTimelineProvider: () => Promise.resolve(),
  $emitTimelineChangeEvent: () => undefined,
}

function makeService(): ExtensionService {
  return new ExtensionService([], noopCommands, noopWindow, noopScm, noopTimeline)
}

describe('ExtensionService window state', () => {
  it('starts focused and exposes it synchronously', () => {
    const service = makeService()
    expect(service.windowState.focused).toBe(true)
  })

  it('fires onDidChangeWindowState only when the value actually changes', () => {
    const service = makeService()
    const events: WindowState[] = []
    service.onDidChangeWindowState((state) => events.push(state))

    // Same as the initial value — must not fire.
    service.acceptWindowState({ focused: true })
    expect(events).toHaveLength(0)

    // Real change — fires once.
    service.acceptWindowState({ focused: false })
    expect(events).toEqual([{ focused: false }])

    // Duplicate of the last value — must not fire again.
    service.acceptWindowState({ focused: false })
    expect(events).toHaveLength(1)

    // Back to focused — fires again.
    service.acceptWindowState({ focused: true })
    expect(events).toEqual([{ focused: false }, { focused: true }])
  })

  it('keeps the windowState getter in sync with the last pushed value', () => {
    const service = makeService()
    service.acceptWindowState({ focused: false })
    expect(service.windowState.focused).toBe(false)
    service.acceptWindowState({ focused: true })
    expect(service.windowState.focused).toBe(true)
  })

  it('acceptWindowState resolves (the RPC surface returns a promise)', async () => {
    const service = makeService()
    const listener = vi.fn()
    service.onDidChangeWindowState(listener)
    service.acceptWindowState({ focused: false })
    expect(listener).toHaveBeenCalledWith({ focused: false })
  })
})
