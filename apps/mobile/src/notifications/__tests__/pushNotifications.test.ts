import { describe, expect, it, vi } from 'vitest'
import {
  base64UrlToUint8Array,
  detectNotificationCapability,
  enablePushNotifications,
  isIos,
  isStandalone,
  toWireSubscription,
  type PushRegistrationLike,
} from '../pushNotifications.js'

describe('detectNotificationCapability', () => {
  it('reports no blocker when everything is available', () => {
    const capability = detectNotificationCapability({
      secureContext: true,
      notificationSupported: true,
      pushSupported: true,
      standalone: true,
      ios: false,
    })
    expect(capability.blocker).toBeUndefined()
  })

  it('names the first missing requirement', () => {
    expect(detectNotificationCapability({ secureContext: false }).blocker).toBe('insecure')
    expect(
      detectNotificationCapability({
        secureContext: true,
        notificationSupported: false,
        pushSupported: true,
      }).blocker,
    ).toBe('notification-unsupported')
    expect(
      detectNotificationCapability({
        secureContext: true,
        notificationSupported: true,
        pushSupported: false,
      }).blocker,
    ).toBe('push-unsupported')
    expect(
      detectNotificationCapability({
        secureContext: true,
        notificationSupported: true,
        pushSupported: true,
        ios: true,
        standalone: false,
      }).blocker,
    ).toBe('ios-not-standalone')
  })

  it('allows an installed iOS PWA', () => {
    expect(
      detectNotificationCapability({
        secureContext: true,
        notificationSupported: true,
        pushSupported: true,
        ios: true,
        standalone: true,
      }).blocker,
    ).toBeUndefined()
  })

  it('guards browser lookups in a non-browser context', () => {
    const capability = detectNotificationCapability({})
    expect(capability.blocker).toBe('insecure')
  })
})

describe('platform hints', () => {
  it('recognises iPhone and iPad device strings', () => {
    const original = navigator.userAgent
    Object.defineProperty(navigator, 'userAgent', {
      configurable: true,
      value: 'Mozilla/5.0 (iPhone)',
    })
    expect(isIos()).toBe(true)
    Object.defineProperty(navigator, 'userAgent', {
      configurable: true,
      value: 'Mozilla/5.0 (X11; Linux)',
    })
    expect(isIos()).toBe(false)
    Object.defineProperty(navigator, 'userAgent', { configurable: true, value: original })
  })

  it('treats display-mode standalone as installed', () => {
    const original = window.matchMedia
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn(() => ({ matches: true }) as unknown as MediaQueryList),
    })
    expect(isStandalone()).toBe(true)
    Object.defineProperty(window, 'matchMedia', { configurable: true, value: original })
  })
})

describe('base64UrlToUint8Array', () => {
  it('decodes base64url without padding', () => {
    expect([...base64UrlToUint8Array('AQID')]).toEqual([1, 2, 3])
    expect([...base64UrlToUint8Array('-_8')]).toEqual([251, 255])
  })
})

describe('toWireSubscription', () => {
  it('reads the browser toJSON shape', () => {
    expect(
      toWireSubscription({
        endpoint: 'https://fcm.googleapis.com/x',
        toJSON: () => ({
          endpoint: 'https://fcm.googleapis.com/x',
          keys: { p256dh: 'p', auth: 'a' },
        }),
      }),
    ).toEqual({ endpoint: 'https://fcm.googleapis.com/x', keys: { p256dh: 'p', auth: 'a' } })
  })

  it('rejects incomplete subscriptions', () => {
    expect(toWireSubscription({ endpoint: 'https://fcm.googleapis.com/x' })).toBeUndefined()
  })
})

function fakeRegistration(
  overrides: {
    existing?: unknown
    created?: unknown
    subscribeError?: Error
  } = {},
): {
  registration: Promise<PushRegistrationLike>
  subscribe: ReturnType<typeof vi.fn>
  getSubscription: ReturnType<typeof vi.fn>
} {
  const subscribe = vi.fn(async () => {
    if (overrides.subscribeError !== undefined) throw overrides.subscribeError
    return overrides.created ?? null
  })
  const getSubscription = vi.fn(async () => overrides.existing ?? null)
  const registration = Promise.resolve({
    pushManager: { getSubscription, subscribe },
  } as unknown as PushRegistrationLike)
  return { registration, subscribe, getSubscription }
}

const SUBSCRIPTION = {
  endpoint: 'https://fcm.googleapis.com/fcm/send/token',
  keys: { p256dh: 'p256dh', auth: 'auth' },
}

describe('enablePushNotifications', () => {
  it('requests permission and subscribes with the VAPID key', async () => {
    const fake = fakeRegistration({ created: SUBSCRIPTION })
    const requestPermission = vi.fn(async () => 'granted' as NotificationPermission)
    const result = await enablePushNotifications({
      permission: 'default',
      requestPermission,
      registration: fake.registration,
      applicationServerKey: 'AQID',
    })

    expect(requestPermission).toHaveBeenCalledTimes(1)
    expect(result).toEqual({ ok: true, subscription: SUBSCRIPTION })
    expect(fake.subscribe).toHaveBeenCalledWith({
      userVisibleOnly: true,
      applicationServerKey: new Uint8Array([1, 2, 3]),
    })
  })

  it('reuses an existing subscription instead of subscribing again', async () => {
    const fake = fakeRegistration({ existing: SUBSCRIPTION })
    const result = await enablePushNotifications({
      permission: 'granted',
      requestPermission: vi.fn(),
      registration: fake.registration,
      applicationServerKey: 'AQID',
    })

    expect(result).toEqual({ ok: true, subscription: SUBSCRIPTION })
    expect(fake.subscribe).not.toHaveBeenCalled()
  })

  it('does not subscribe when permission is denied', async () => {
    const fake = fakeRegistration()
    const result = await enablePushNotifications({
      permission: 'default',
      requestPermission: vi.fn(async () => 'denied' as NotificationPermission),
      registration: fake.registration,
      applicationServerKey: 'AQID',
    })

    expect(result).toEqual({ ok: false, reason: 'denied' })
    expect(fake.subscribe).not.toHaveBeenCalled()
  })

  it('reports an empty or malformed VAPID key as unsupported', async () => {
    const fake = fakeRegistration()
    expect(
      await enablePushNotifications({
        permission: 'granted',
        requestPermission: vi.fn(),
        registration: fake.registration,
        applicationServerKey: '',
      }),
    ).toEqual({ ok: false, reason: 'unsupported' })
    expect(
      await enablePushNotifications({
        permission: 'granted',
        requestPermission: vi.fn(),
        registration: fake.registration,
        applicationServerKey: '***',
      }),
    ).toMatchObject({ ok: false, reason: 'unsupported' })
  })

  it('folds a throwing subscribe into a failure', async () => {
    const fake = fakeRegistration({ subscribeError: new Error('registration failed') })
    const result = await enablePushNotifications({
      permission: 'granted',
      requestPermission: vi.fn(),
      registration: fake.registration,
      applicationServerKey: 'AQID',
    })
    expect(result).toEqual({ ok: false, reason: 'failed', error: 'registration failed' })
  })

  it('rejects a subscription without keys', async () => {
    const fake = fakeRegistration({
      created: { endpoint: 'https://fcm.googleapis.com/x' },
    })
    const result = await enablePushNotifications({
      permission: 'granted',
      requestPermission: vi.fn(),
      registration: fake.registration,
      applicationServerKey: 'AQID',
    })
    expect(result).toMatchObject({ ok: false, reason: 'unsupported' })
  })
})
