/*---------------------------------------------------------------------------------------------
 *  Tests for the host-side SCM bridge (HostSourceControl via ExtensionService):
 *  creating a source control / groups, serializing resource states to DTOs,
 *  two-way input-box value flow.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest'
import type {
  IMainThreadCommands,
  IMainThreadScm,
  IMainThreadWindow,
} from '@universe-editor/extensions-common'
import { ExtensionService } from '../extensionService.js'

const noopCommands: IMainThreadCommands = {
  $registerCommand: () => Promise.resolve(),
  $unregisterCommand: () => Promise.resolve(),
  $executeCommand: () => Promise.resolve(undefined),
}
const noopWindow: IMainThreadWindow = {
  $showMessage: () => Promise.resolve(undefined),
  $showQuickPick: () => Promise.resolve(undefined),
  $showInputBox: () => Promise.resolve(undefined),
  $setStatusBarEntry: () => Promise.resolve(),
  $disposeStatusBarEntry: () => Promise.resolve(),
}

function recordingScm(): IMainThreadScm & {
  registerSourceControl: ReturnType<typeof vi.fn>
  registerGroup: ReturnType<typeof vi.fn>
  updateSourceControl: ReturnType<typeof vi.fn>
  updateGroupResourceStates: ReturnType<typeof vi.fn>
  setInputBoxValue: ReturnType<typeof vi.fn>
} {
  const registerSourceControl = vi.fn().mockResolvedValue(undefined)
  const registerGroup = vi.fn().mockResolvedValue(undefined)
  const updateSourceControl = vi.fn().mockResolvedValue(undefined)
  const updateGroupResourceStates = vi.fn().mockResolvedValue(undefined)
  const setInputBoxValue = vi.fn().mockResolvedValue(undefined)
  return {
    registerSourceControl,
    registerGroup,
    updateSourceControl,
    updateGroupResourceStates,
    setInputBoxValue,
    $registerSourceControl: registerSourceControl,
    $updateSourceControl: updateSourceControl,
    $unregisterSourceControl: () => Promise.resolve(),
    $registerGroup: registerGroup,
    $updateGroup: () => Promise.resolve(),
    $updateGroupResourceStates: updateGroupResourceStates,
    $unregisterGroup: () => Promise.resolve(),
    $setInputBoxValue: setInputBoxValue,
    $setInputBoxPlaceholder: () => Promise.resolve(),
  }
}

describe('host SCM bridge', () => {
  it('registers a source control and its groups with unique handles', () => {
    const scm = recordingScm()
    const service = new ExtensionService([], noopCommands, noopWindow, scm)

    const sc = service.createSourceControl('git', 'Git', '/repo')
    expect(scm.registerSourceControl).toHaveBeenCalledWith(0, 'git', 'Git', '/repo')

    sc.createResourceGroup('index', 'Staged')
    sc.createResourceGroup('workingTree', 'Changes')
    expect(scm.registerGroup.mock.calls.map((c) => c[1])).toEqual([1, 2])
  })

  it('serializes resource states (command + decorations) to DTOs', () => {
    const scm = recordingScm()
    const service = new ExtensionService([], noopCommands, noopWindow, scm)
    const group = service.createSourceControl('git', 'Git').createResourceGroup('wt', 'Changes')

    group.resourceStates = [
      {
        resourceUri: '/repo/a.ts',
        contextValue: 'M',
        command: { command: 'git.openChange', title: 'Open' },
        decorations: { color: '#e2c08d', strikeThrough: false },
      },
    ]

    const [, resources] = scm.updateGroupResourceStates.mock.calls[0]!
    expect(resources).toEqual([
      {
        resourceUri: '/repo/a.ts',
        contextValue: 'M',
        command: { command: 'git.openChange', title: 'Open' },
        decorations: { color: '#e2c08d', strikeThrough: false },
      },
    ])
  })

  it('flows input-box value both ways', () => {
    const scm = recordingScm()
    const service = new ExtensionService([], noopCommands, noopWindow, scm)
    const sc = service.createSourceControl('git', 'Git')

    sc.inputBox.value = 'host set'
    expect(scm.setInputBoxValue).toHaveBeenCalledWith(0, 'host set')

    const changed = vi.fn()
    sc.inputBox.onDidChange(changed)
    service.onInputBoxValueChange(0, 'user typed')
    expect(sc.inputBox.value).toBe('user typed')
    expect(changed).toHaveBeenCalledWith('user typed')
  })

  it('sends a cleared acceptInputActions so the renderer can collapse the split button', () => {
    // Regression: setting acceptInputActions back to undefined (git does this
    // after a commit, when only a single Push button should remain) must still
    // reach the renderer. A spread that drops undefined keys leaves the renderer
    // holding the stale commit actions, so the button never becomes "Push".
    const scm = recordingScm()
    const service = new ExtensionService([], noopCommands, noopWindow, scm)
    const sc = service.createSourceControl('git', 'Git')

    sc.acceptInputActions = [
      { command: 'git.commit', title: 'Commit' },
      { command: 'git.commitAndPush', title: 'Commit & Push' },
    ]
    const withActions = scm.updateSourceControl.mock.calls.at(-1)![1]
    expect(withActions.acceptInputActions).toHaveLength(2)

    sc.acceptInputActions = undefined
    const cleared = scm.updateSourceControl.mock.calls.at(-1)![1]
    expect(cleared.acceptInputActions).toEqual([])
  })
})
