import { describe, expect, it, vi } from 'vitest'
import type { ILogger } from '@universe-editor/platform'
import type {
  MobileAttentionKind,
  MobilePushSubscription,
  NotificationFrame,
} from '@universe-editor/mobile-protocol'
import type { MobileNotifyTarget } from '../deviceStore.js'
import {
  MobileNotificationRouter,
  buildNotificationContent,
  type AttentionNotificationInput,
  type MobileNotificationRouterOptions,
} from '../mobileNotificationRouter.js'
import type { VapidKeyPair } from '../vapidKeys.js'
import type { WebPushSendOptions, WebPushSendResult, WebPushSender } from '../webPushSender.js'

const VAPID: VapidKeyPair = { publicKey: 'public-key', privateKey: 'private-key' }
const SUBJECT = 'https://universe-editor.example.com'
const ENDPOINT = 'https://fcm.googleapis.com/fcm/send/device-token'

interface RecordingLogger extends ILogger {
  readonly warns: string[]
  readonly infos: string[]
  readonly debugs: string[]
}

function recordingLogger(): RecordingLogger {
  const warns: string[] = []
  const infos: string[] = []
  const debugs: string[] = []
  const logger = {
    trace: () => {},
    debug: (message: string) => debugs.push(message),
    info: (message: string) => infos.push(message),
    warn: (message: string) => warns.push(message),
    error: () => {},
    warns,
    infos,
    debugs,
  }
  return logger as unknown as RecordingLogger
}

function target(
  overrides: {
    deviceId?: string
    enabled?: boolean
    kinds?: readonly MobileAttentionKind[]
    alwaysNotify?: boolean
    withPush?: boolean
  } = {},
): MobileNotifyTarget {
  return {
    deviceId: overrides.deviceId ?? 'd1',
    notifications: {
      enabled: overrides.enabled ?? true,
      ...(overrides.kinds !== undefined ? { kinds: overrides.kinds } : {}),
      alwaysNotify: overrides.alwaysNotify ?? false,
    },
    ...(overrides.withPush === false
      ? {}
      : {
          push: {
            endpoint: ENDPOINT,
            keys: { p256dh: 'p256dh', auth: 'auth' },
            updatedAt: 1,
          },
        }),
  }
}

function fakeSender(results: readonly WebPushSendResult[] = [{ ok: true }]) {
  const queue = [...results]
  const calls: Array<{
    subscription: MobilePushSubscription
    payload: string
    options: WebPushSendOptions
  }> = []
  const send = vi.fn(
    async (
      subscription: MobilePushSubscription,
      payload: string,
      options: WebPushSendOptions,
    ): Promise<WebPushSendResult> => {
      calls.push({ subscription, payload, options })
      return queue.shift() ?? { ok: true }
    },
  )
  return { sender: { send } as WebPushSender, calls, send }
}

function setup(
  overrides: {
    targets?: readonly MobileNotifyTarget[]
    focused?: boolean
    visible?: readonly string[]
    sendToVisibleDevices?: (deviceId: string, frame: NotificationFrame) => boolean
    sender?: WebPushSender
    includeSender?: boolean
    includeVapid?: boolean
    onPushSubscriptionGone?: (deviceId: string) => Promise<void>
    listTargets?: () => Promise<readonly MobileNotifyTarget[]>
  } = {},
) {
  const logger = recordingLogger()
  const visible = new Set(overrides.visible ?? [])
  const frames: Array<{ deviceId: string; frame: NotificationFrame }> = []
  const gone: string[] = []
  const options: MobileNotificationRouterOptions = {
    logger,
    listTargets: overrides.listTargets ?? (async () => overrides.targets ?? []),
    isPcFocused: () => overrides.focused ?? false,
    isDeviceVisible: (deviceId) => visible.has(deviceId),
    sendToVisibleDevices:
      overrides.sendToVisibleDevices ??
      ((deviceId, frame) => {
        if (!visible.has(deviceId)) return false
        frames.push({ deviceId, frame })
        return true
      }),
    subject: SUBJECT,
    onPushSubscriptionGone: async (deviceId) => {
      gone.push(deviceId)
      await overrides.onPushSubscriptionGone?.(deviceId)
    },
    now: () => 1_700_000_000_000,
    createId: () => 'notification-1',
    ...(overrides.includeSender === false || overrides.sender === undefined
      ? {}
      : { pushSender: overrides.sender }),
    ...(overrides.includeVapid === false ? {} : { vapid: VAPID }),
  }
  return {
    router: new MobileNotificationRouter(options),
    logger,
    frames,
    gone,
  }
}

const COMPLETED: AttentionNotificationInput = {
  kind: 'completed',
  ref: { windowId: 1, localId: 'local-1', durableId: 'durable-1' },
  title: 'Fix the parser',
  agentName: 'Claude',
}

describe('buildNotificationContent', () => {
  it('uses Chinese category bodies without prompt or tool output', () => {
    expect(
      buildNotificationContent({
        kind: 'permission',
        ref: { windowId: 1, localId: 'l1' },
        title: 'Fix the parser',
        permissionTitle: 'Run shell command',
      }),
    ).toEqual({ title: 'Fix the parser', body: '等待审批：Run shell command' })

    expect(buildNotificationContent({ ...COMPLETED, kind: 'question' })).toEqual({
      title: 'Fix the parser',
      body: 'Agent 提问',
    })
    expect(buildNotificationContent(COMPLETED)).toEqual({
      title: 'Fix the parser',
      body: '已完成',
    })
    expect(buildNotificationContent({ ...COMPLETED, kind: 'errored' })).toEqual({
      title: 'Fix the parser',
      body: '出错',
    })
  })

  it('falls back to the agent name and a generic approval detail', () => {
    expect(
      buildNotificationContent({
        kind: 'permission',
        ref: { windowId: 1, localId: 'l1' },
        title: '   ',
        agentName: 'Codex',
      }),
    ).toEqual({ title: 'Codex', body: '等待审批：需要你的确认' })
    expect(
      buildNotificationContent({
        kind: 'question',
        ref: { windowId: 1, localId: 'l1' },
        title: '',
        agentName: '',
      }),
    ).toEqual({ title: 'Agent', body: 'Agent 提问' })
  })

  it('clamps overlong titles', () => {
    const content = buildNotificationContent({ ...COMPLETED, title: 'x'.repeat(900) })
    expect(content.title.length).toBe(512)
    expect(content.title.endsWith('…')).toBe(true)
  })
})

describe('MobileNotificationRouter', () => {
  it('sends a Web Push when the phone is in the background', async () => {
    const sender = fakeSender()
    const h = setup({ targets: [target()], sender: sender.sender })

    await h.router.notify(COMPLETED)

    expect(sender.send).toHaveBeenCalledTimes(1)
    const call = sender.calls[0]!
    expect(call.subscription).toEqual({
      endpoint: ENDPOINT,
      keys: { p256dh: 'p256dh', auth: 'auth' },
    })
    expect(call.options).toMatchObject({
      vapid: VAPID,
      subject: SUBJECT,
      ttlSeconds: 3600,
      urgency: 'normal',
    })
    expect(JSON.parse(call.payload)).toEqual({
      id: 'notification-1',
      kind: 'completed',
      title: 'Fix the parser',
      body: '已完成',
      url: '/s/durable-1',
      tag: 'session:durable-1',
      at: 1_700_000_000_000,
    })
    expect(h.frames).toHaveLength(0)
  })

  it('uses high urgency and a pending deep link for approvals', async () => {
    const sender = fakeSender()
    const h = setup({ targets: [target()], sender: sender.sender })

    await h.router.notify({
      kind: 'permission',
      ref: { windowId: 1, localId: 'local-1' },
      title: 'Fix the parser',
      permissionTitle: 'Edit file',
    })

    const call = sender.calls[0]!
    expect(call.options.urgency).toBe('high')
    expect(JSON.parse(call.payload)).toMatchObject({
      kind: 'permission',
      body: '等待审批：Edit file',
      url: '/s/local-1?focus=pending',
      tag: 'session:local-1',
    })
  })

  it('keeps prompt and tool output out of the payload', async () => {
    const sender = fakeSender()
    const h = setup({ targets: [target()], sender: sender.sender })
    const input = {
      ...COMPLETED,
      title: 'Session title',
      permissionTitle: 'Run shell command',
      prompt: 'super secret prompt',
      toolOutput: 'super secret output',
    } as AttentionNotificationInput

    await h.router.notify(input)

    const payload = sender.calls[0]!.payload
    expect(payload).not.toContain('super secret')
    expect(Object.keys(JSON.parse(payload) as Record<string, unknown>).sort()).toEqual([
      'at',
      'body',
      'id',
      'kind',
      'tag',
      'title',
      'url',
    ])
  })

  it('filters disabled devices and disabled kinds', async () => {
    const sender = fakeSender()
    const h = setup({
      targets: [
        target({ deviceId: 'disabled', enabled: false }),
        target({ deviceId: 'filtered', kinds: ['permission'] }),
        target({ deviceId: 'allowed', kinds: ['completed'] }),
      ],
      sender: sender.sender,
    })

    await h.router.notify(COMPLETED)

    expect(sender.send).toHaveBeenCalledTimes(1)
    expect(h.logger.warns).toHaveLength(0)
  })

  it('suppresses devices while a PC window is focused unless alwaysNotify', async () => {
    const sender = fakeSender()
    const h = setup({
      focused: true,
      targets: [target({ deviceId: 'quiet' }), target({ deviceId: 'loud', alwaysNotify: true })],
      sender: sender.sender,
    })

    await h.router.notify(COMPLETED)

    expect(sender.send).toHaveBeenCalledTimes(1)
    expect(sender.calls[0]?.subscription.endpoint).toBe(ENDPOINT)
  })

  it('sends an in-app frame when the device declares itself visible', async () => {
    const sender = fakeSender()
    const h = setup({
      targets: [target()],
      visible: ['d1'],
      sender: sender.sender,
    })

    await h.router.notify(COMPLETED)

    expect(sender.send).not.toHaveBeenCalled()
    expect(h.frames).toHaveLength(1)
    expect(h.frames[0]?.deviceId).toBe('d1')
    expect(h.frames[0]?.frame).toEqual({
      type: 'notification',
      id: 'notification-1',
      kind: 'completed',
      ref: COMPLETED.ref,
      title: 'Fix the parser',
      body: '已完成',
      at: 1_700_000_000_000,
    })
  })

  it('falls back to push when the visible send fails', async () => {
    const sender = fakeSender()
    const h = setup({
      targets: [target()],
      visible: ['d1'],
      sendToVisibleDevices: () => false,
      sender: sender.sender,
    })

    await h.router.notify(COMPLETED)

    expect(sender.send).toHaveBeenCalledTimes(1)
  })

  it('drops a subscription the push service reports as gone', async () => {
    const sender = fakeSender([
      { ok: false, statusCode: 410, error: 'Gone' },
      { ok: false, statusCode: 404, error: 'Not Found' },
    ])
    const h = setup({
      targets: [target({ deviceId: 'a' }), target({ deviceId: 'b' })],
      sender: sender.sender,
    })

    await h.router.notify(COMPLETED)

    expect(h.gone).toEqual(['a', 'b'])
    expect(h.logger.infos.some((line) => line.includes('subscription expired'))).toBe(true)
  })

  it('logs other push failures without throwing', async () => {
    const sender = fakeSender([{ ok: false, statusCode: 500, error: 'server exploded' }])
    const h = setup({ targets: [target()], sender: sender.sender })

    await expect(h.router.notify(COMPLETED)).resolves.toBeUndefined()

    expect(h.gone).toHaveLength(0)
    expect(h.logger.warns.some((line) => line.includes('status=500'))).toBe(true)
  })

  it('logs a thrown send and keeps going', async () => {
    const send = vi.fn(async (): Promise<WebPushSendResult> => {
      throw new Error('socket hang up')
    })
    const h = setup({
      targets: [target()],
      sender: { send } as WebPushSender,
    })

    await expect(h.router.notify(COMPLETED)).resolves.toBeUndefined()
    expect(h.logger.warns.some((line) => line.includes('socket hang up'))).toBe(true)
  })

  it('skips push when no sender or VAPID key is configured', async () => {
    const h = setup({ targets: [target()], includeSender: false })
    await expect(h.router.notify(COMPLETED)).resolves.toBeUndefined()
    expect(h.frames).toHaveLength(0)

    const noVapid = setup({ targets: [target()], sender: fakeSender().sender, includeVapid: false })
    await expect(noVapid.router.notify(COMPLETED)).resolves.toBeUndefined()
  })

  it('does nothing for devices without a stored subscription', async () => {
    const sender = fakeSender()
    const h = setup({ targets: [target({ withPush: false })], sender: sender.sender })

    await h.router.notify(COMPLETED)

    expect(sender.send).not.toHaveBeenCalled()
  })

  it('tolerates a failing target lookup', async () => {
    const h = setup({
      listTargets: async () => {
        throw new Error('devices.json unreadable')
      },
    })

    await expect(h.router.notify(COMPLETED)).resolves.toBeUndefined()
    expect(h.logger.warns.some((line) => line.includes('devices.json unreadable'))).toBe(true)
  })

  it('refuses to send an oversized payload', async () => {
    const sender = fakeSender()
    const h = setup({ targets: [target()], sender: sender.sender })

    await h.router.notify({
      ...COMPLETED,
      ref: { windowId: 1, localId: 'x'.repeat(5000) },
    })

    expect(sender.send).not.toHaveBeenCalled()
    expect(h.logger.warns.some((line) => line.includes('payload exceeds'))).toBe(true)
  })
})
