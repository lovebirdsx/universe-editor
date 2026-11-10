import type {
  MobileConfigOption,
  MobilePendingPermission,
  MobileSessionEvent,
  MobileSessionSnapshot,
} from '@universe-editor/mobile-protocol'
import { describe, expect, it } from 'vitest'
import {
  widenConfigOptionForTrust,
  widenEventForTrust,
  widenPermissionForTrust,
  widenSnapshotForTrust,
} from '../trustedProjection.js'

function configOption(overrides: Partial<MobileConfigOption> = {}): MobileConfigOption {
  return {
    id: 'approval',
    name: 'Approval',
    type: 'select',
    currentValue: 'ask',
    allowedOnMobile: true,
    options: [
      { value: 'ask', label: 'Ask', allowedOnMobile: true },
      { value: 'bypassPermissions', label: 'Bypass', allowedOnMobile: false },
    ],
    ...overrides,
  }
}

function permission(overrides: Partial<MobilePendingPermission> = {}): MobilePendingPermission {
  return {
    requestId: 'req-1',
    toolCallId: 'tool-1',
    title: 'Run command',
    options: [
      { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once', allowedOnMobile: true },
      {
        optionId: 'allow-always',
        name: 'Always',
        kind: 'allow_always',
        allowedOnMobile: false,
      },
    ],
    ...overrides,
  }
}

describe('widenConfigOptionForTrust', () => {
  it('enables only high-risk values and recomputes the option flag', () => {
    const original = configOption()
    const widened = widenConfigOptionForTrust(original)

    expect(widened.options?.map((value) => value.allowedOnMobile)).toEqual([true, true])
    expect(widened.allowedOnMobile).toBe(true)
    expect(original.options?.[1]?.allowedOnMobile).toBe(false)
  })

  it('returns the same reference when no value is high-risk', () => {
    const original = configOption({
      options: [{ value: 'ask', label: 'Ask', allowedOnMobile: true }],
    })
    expect(widenConfigOptionForTrust(original)).toBe(original)
  })

  it('leaves boolean options untouched', () => {
    const original: MobileConfigOption = {
      id: 'approval',
      name: 'Approval',
      type: 'boolean',
      currentValue: 'true',
      allowedOnMobile: true,
    }
    expect(widenConfigOptionForTrust(original)).toBe(original)
  })
})

describe('widenPermissionForTrust', () => {
  it('enables durable grants and keeps other options unchanged', () => {
    const original = permission()
    const widened = widenPermissionForTrust(original)

    expect(widened.options.map((option) => option.allowedOnMobile)).toEqual([true, true])
    expect(original.options[1]?.allowedOnMobile).toBe(false)
  })

  it('returns the same reference when nothing is high-risk', () => {
    const original = permission({
      options: [
        { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once', allowedOnMobile: true },
      ],
    })
    expect(widenPermissionForTrust(original)).toBe(original)
  })
})

describe('widenSnapshotForTrust / widenEventForTrust', () => {
  it('widens config options and the pending permission without mutating the input', () => {
    const snapshot: MobileSessionSnapshot = {
      summary: {
        ref: { windowId: 1, localId: 's1' },
        agentId: 'fake',
        agentName: 'Fake',
        title: 'Session',
        status: 'idle',
        displayStatus: 'idle',
        bucket: 'in_progress',
        workspaceName: 'workspace',
        cwd: '/workspace',
        readOnly: false,
        hasPendingPermission: true,
        hasPendingElicitation: false,
        backgroundTaskCount: 0,
        updatedAt: 1,
      },
      timeline: [],
      plan: [],
      configOptions: [configOption()],
      availableCommands: [],
      pendingPermission: permission(),
      isReplayingHistory: false,
      seq: 1,
    }

    const widened = widenSnapshotForTrust(snapshot)
    expect(widened).not.toBe(snapshot)
    expect(widened.configOptions[0]?.options?.[1]?.allowedOnMobile).toBe(true)
    expect(widened.pendingPermission?.options[1]?.allowedOnMobile).toBe(true)
    expect(snapshot.configOptions[0]?.options?.[1]?.allowedOnMobile).toBe(false)
    expect(snapshot.pendingPermission?.options[1]?.allowedOnMobile).toBe(false)
  })

  it('returns the same snapshot when there is nothing to widen', () => {
    const snapshot: MobileSessionSnapshot = {
      summary: {
        ref: { windowId: 1, localId: 's1' },
        agentId: 'fake',
        agentName: 'Fake',
        title: 'Session',
        status: 'idle',
        displayStatus: 'idle',
        bucket: 'in_progress',
        workspaceName: 'workspace',
        cwd: '/workspace',
        readOnly: false,
        hasPendingPermission: false,
        hasPendingElicitation: false,
        backgroundTaskCount: 0,
        updatedAt: 1,
      },
      timeline: [],
      plan: [],
      configOptions: [],
      availableCommands: [],
      isReplayingHistory: false,
      seq: 1,
    }
    expect(widenSnapshotForTrust(snapshot)).toBe(snapshot)
  })

  it('widens config and permission delta events, leaving other events as-is', () => {
    const configEvent: MobileSessionEvent = {
      type: 'config_options_snapshot',
      options: [configOption()],
    }
    const permissionEvent: MobileSessionEvent = {
      type: 'permission_upsert',
      permission: permission(),
    }
    const messageEvent: MobileSessionEvent = {
      type: 'message_upsert',
      id: 'm1',
      role: 'agent',
      streaming: false,
      textAppend: 'x',
    }

    const widenedConfig = widenEventForTrust(configEvent)
    expect(widenedConfig).toMatchObject({
      type: 'config_options_snapshot',
      options: [{ options: [{ allowedOnMobile: true }, { allowedOnMobile: true }] }],
    })
    expect(widenEventForTrust(permissionEvent)).toMatchObject({
      type: 'permission_upsert',
      permission: { options: [{ allowedOnMobile: true }, { allowedOnMobile: true }] },
    })
    expect(widenEventForTrust(messageEvent)).toBe(messageEvent)
  })
})
