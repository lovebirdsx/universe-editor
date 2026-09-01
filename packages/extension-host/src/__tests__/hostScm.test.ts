/*---------------------------------------------------------------------------------------------
 *  Tests for the host-side SCM bridge (HostSourceControl via ExtensionService):
 *  creating a source control / groups, serializing resource states to DTOs,
 *  two-way input-box value flow.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest'
import type {
  IMainThreadCommands,
  IMainThreadScm,
  IMainThreadTimeline,
  IMainThreadWindow,
} from '@universe-editor/extensions-common'
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
const noopTimeline: IMainThreadTimeline = {
  $registerTimelineProvider: () => Promise.resolve(),
  $unregisterTimelineProvider: () => Promise.resolve(),
  $emitTimelineChangeEvent: () => undefined,
}

function recordingScm(): IMainThreadScm & {
  registerSourceControl: ReturnType<typeof vi.fn>
  registerGroup: ReturnType<typeof vi.fn>
  updateSourceControl: ReturnType<typeof vi.fn>
  updateGroupResourceStates: ReturnType<typeof vi.fn>
  setInputBoxValue: ReturnType<typeof vi.fn>
  updateSupplementary: ReturnType<typeof vi.fn>
  publishWorkingTreeScan: ReturnType<typeof vi.fn>
} {
  const registerSourceControl = vi.fn().mockResolvedValue(undefined)
  const registerGroup = vi.fn().mockResolvedValue(undefined)
  const updateSourceControl = vi.fn().mockResolvedValue(undefined)
  const updateGroupResourceStates = vi.fn().mockResolvedValue(undefined)
  const setInputBoxValue = vi.fn().mockResolvedValue(undefined)
  const updateSupplementary = vi.fn().mockResolvedValue(undefined)
  const publishWorkingTreeScan = vi.fn().mockResolvedValue(undefined)
  return {
    registerSourceControl,
    registerGroup,
    updateSourceControl,
    updateGroupResourceStates,
    setInputBoxValue,
    updateSupplementary,
    publishWorkingTreeScan,
    $registerSourceControl: registerSourceControl,
    $updateSourceControl: updateSourceControl,
    $unregisterSourceControl: () => Promise.resolve(),
    $registerGroup: registerGroup,
    $updateGroup: () => Promise.resolve(),
    $updateGroupResourceStates: updateGroupResourceStates,
    $unregisterGroup: () => Promise.resolve(),
    $updateSupplementaryDecorations: updateSupplementary,
    $publishWorkingTreeScan: publishWorkingTreeScan,
    $setInputBoxValue: setInputBoxValue,
    $setInputBoxPlaceholder: () => Promise.resolve(),
  }
}

describe('host SCM bridge', () => {
  it('registers a source control and its groups with unique handles', () => {
    const scm = recordingScm()
    const service = new ExtensionService([], noopCommands, noopWindow, scm, noopTimeline)

    const sc = service.createSourceControl('git', 'Git', '/repo')
    expect(scm.registerSourceControl).toHaveBeenCalledWith(0, 'git', 'Git', '/repo')

    sc.createResourceGroup('index', 'Staged')
    sc.createResourceGroup('workingTree', 'Changes')
    expect(scm.registerGroup.mock.calls.map((c) => c[1])).toEqual([1, 2])
  })

  it('serializes resource states (command + decorations) to DTOs', () => {
    const scm = recordingScm()
    const service = new ExtensionService([], noopCommands, noopWindow, scm, noopTimeline)
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
    const service = new ExtensionService([], noopCommands, noopWindow, scm, noopTimeline)
    const sc = service.createSourceControl('git', 'Git')

    sc.inputBox.value = 'host set'
    expect(scm.setInputBoxValue).toHaveBeenCalledWith(0, 'host set')

    const changed = vi.fn()
    sc.inputBox.onDidChange(changed)
    service.onInputBoxValueChange(0, 'user typed')
    expect(sc.inputBox.value).toBe('user typed')
    expect(changed).toHaveBeenCalledWith('user typed')
  })

  it('forwards a working-tree scan batch to the renderer, and never with zero entries', () => {
    const scm = recordingScm()
    const service = new ExtensionService([], noopCommands, noopWindow, scm, noopTimeline)
    const sc = service.createSourceControl('perforce', 'Perforce')

    sc.publishWorkingTreeScan([
      {
        directory: '/repo/src',
        changes: [
          { path: '/repo/src/a.ts', letter: 'RC', color: '#e2c08d', tooltip: 'Not opened · Edit' },
        ],
      },
    ])
    expect(scm.publishWorkingTreeScan).toHaveBeenCalledWith(0, [
      {
        directory: '/repo/src',
        hints: [
          { path: '/repo/src/a.ts', letter: 'RC', color: '#e2c08d', tooltip: 'Not opened · Edit' },
        ],
      },
    ])

    sc.publishWorkingTreeScan([])
    expect(scm.publishWorkingTreeScan).toHaveBeenCalledTimes(1)
  })

  it('sends a cleared acceptInputActions so the renderer can collapse the split button', () => {
    // Regression: setting acceptInputActions back to undefined (git does this
    // after a commit, when only a single Push button should remain) must still
    // reach the renderer. A spread that drops undefined keys leaves the renderer
    // holding the stale commit actions, so the button never becomes "Push".
    const scm = recordingScm()
    const service = new ExtensionService([], noopCommands, noopWindow, scm, noopTimeline)
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

describe('supplementary decorations', () => {
  it('sends the initial set and stays silent when nothing changed', () => {
    const scm = recordingScm()
    const service = new ExtensionService([], noopCommands, noopWindow, scm, noopTimeline)
    const sc = service.createSourceControl('perforce', 'Perforce')

    sc.setSupplementaryDecorations([
      { resourceUri: '/ws/a.ts', description: '可更新', tooltip: '#4 → #7' },
      { resourceUri: '/ws/b.fbx', description: '他人占用' },
    ])
    expect(scm.updateSupplementary).toHaveBeenCalledTimes(1)
    const [handle, deltas] = scm.updateSupplementary.mock.calls[0]!
    expect(handle).toBe(0)
    expect(deltas).toEqual([
      { resourceUri: '/ws/a.ts', description: '可更新', tooltip: '#4 → #7' },
      { resourceUri: '/ws/b.fbx', description: '他人占用' },
    ])

    // A background scan that finds the same thing must cost no RPC: providers
    // re-set the whole set on every poll.
    sc.setSupplementaryDecorations([
      { resourceUri: '/ws/a.ts', description: '可更新', tooltip: '#4 → #7' },
      { resourceUri: '/ws/b.fbx', description: '他人占用' },
    ])
    expect(scm.updateSupplementary).toHaveBeenCalledTimes(1)
  })

  it('diffs to the minimal delta, removals first', () => {
    const scm = recordingScm()
    const service = new ExtensionService([], noopCommands, noopWindow, scm, noopTimeline)
    const sc = service.createSourceControl('perforce', 'Perforce')

    sc.setSupplementaryDecorations([
      { resourceUri: '/ws/a.ts', description: '可更新' },
      { resourceUri: '/ws/b.fbx', description: '他人占用' },
      { resourceUri: '/ws/c.ini', description: '可更新' },
    ])
    // b disappears, c's tooltip appears, a is untouched, d is new.
    sc.setSupplementaryDecorations([
      { resourceUri: '/ws/a.ts', description: '可更新' },
      { resourceUri: '/ws/c.ini', description: '可更新', tooltip: '#1 → #2' },
      { resourceUri: '/ws/d.cs', description: '他人占用' },
    ])

    const deltas = scm.updateSupplementary.mock.calls.at(-1)![1]
    expect(deltas).toEqual([
      { resourceUri: '/ws/b.fbx', description: null },
      { resourceUri: '/ws/c.ini', description: '可更新', tooltip: '#1 → #2' },
      { resourceUri: '/ws/d.cs', description: '他人占用' },
    ])
  })

  it('clears everything with an empty set', () => {
    const scm = recordingScm()
    const service = new ExtensionService([], noopCommands, noopWindow, scm, noopTimeline)
    const sc = service.createSourceControl('perforce', 'Perforce')

    sc.setSupplementaryDecorations([{ resourceUri: '/ws/a.ts', description: '可更新' }])
    sc.setSupplementaryDecorations([])
    expect(scm.updateSupplementary.mock.calls.at(-1)![1]).toEqual([
      { resourceUri: '/ws/a.ts', description: null },
    ])

    // Already empty — no further traffic.
    sc.setSupplementaryDecorations([])
    expect(scm.updateSupplementary).toHaveBeenCalledTimes(2)
  })

  it('drops a tooltip that goes away', () => {
    const scm = recordingScm()
    const service = new ExtensionService([], noopCommands, noopWindow, scm, noopTimeline)
    const sc = service.createSourceControl('perforce', 'Perforce')

    sc.setSupplementaryDecorations([
      { resourceUri: '/ws/a.ts', description: '可更新', tooltip: '#4 → #7' },
    ])
    sc.setSupplementaryDecorations([{ resourceUri: '/ws/a.ts', description: '可更新' }])
    expect(scm.updateSupplementary.mock.calls.at(-1)![1]).toEqual([
      { resourceUri: '/ws/a.ts', description: '可更新' },
    ])
  })
})
