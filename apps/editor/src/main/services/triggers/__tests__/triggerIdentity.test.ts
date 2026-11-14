/*---------------------------------------------------------------------------------------------
 *  Tests for the composite workspace + trigger id used by state, queue and IPC.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import { getPathComparisonKey } from '@universe-editor/platform'
import {
  parseTriggerKey,
  triggerKeyBelongsToWorkspace,
  triggerKeyFor,
  workspaceComparisonKey,
} from '../triggerIdentity.js'

describe('trigger identity', () => {
  it('builds a key from the normalized workspace plus the bare id', () => {
    const key = triggerKeyFor('X:/workspace/one', 'weekly', 'win32')
    expect(key).toBe(`${getPathComparisonKey('X:/workspace/one', 'win32')}\u0000weekly`)
    expect(parseTriggerKey(key)).toEqual({
      workspaceKey: getPathComparisonKey('X:/workspace/one', 'win32'),
      triggerId: 'weekly',
    })
  })

  it('gives the same trigger id distinct keys in different workspaces', () => {
    const left = triggerKeyFor('X:/workspace/one', 'weekly', 'win32')
    const right = triggerKeyFor('X:/workspace/two', 'weekly', 'win32')
    expect(left).not.toBe(right)
    expect(parseTriggerKey(left)?.triggerId).toBe('weekly')
    expect(parseTriggerKey(right)?.triggerId).toBe('weekly')
  })

  it('folds path casing/separators through the kernel comparison key only', () => {
    expect(workspaceComparisonKey('C:\\Work\\Repo', 'win32')).toBe(
      getPathComparisonKey('c:/work/repo', 'win32'),
    )
    expect(workspaceComparisonKey('/home/dev/repo', 'linux')).toBe(
      getPathComparisonKey('/home/dev/repo', 'linux'),
    )
    expect(workspaceComparisonKey('/home/dev/repo', 'linux')).not.toBe(
      workspaceComparisonKey('/home/DEV/repo', 'linux'),
    )
  })

  it('rejects malformed keys and scopes membership by workspace', () => {
    expect(parseTriggerKey('weekly')).toBeUndefined()
    expect(parseTriggerKey('\u0000weekly')).toBeUndefined()
    expect(parseTriggerKey(`${getPathComparisonKey('X:/w', 'win32')}\u0000`)).toBeUndefined()

    const workspaceKey = workspaceComparisonKey('X:/workspace/one', 'win32')
    expect(triggerKeyBelongsToWorkspace(triggerKeyFor('X:/Workspace/One', 'a', 'win32'), workspaceKey)).toBe(true)
    expect(triggerKeyBelongsToWorkspace(triggerKeyFor('X:/workspace/two', 'a', 'win32'), workspaceKey)).toBe(false)
  })
})
