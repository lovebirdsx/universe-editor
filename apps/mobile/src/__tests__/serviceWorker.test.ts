import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'

const SOURCE = readFileSync(resolve(process.cwd(), 'public/sw.js'), 'utf8')

type Listener = (event: Record<string, unknown>) => void

interface LoadedWorker {
  readonly listeners: Map<string, Listener>
  readonly shown: Array<{ title: string; options: Record<string, unknown> }>
  readonly self: {
    location: { origin: string }
    registration: { showNotification: ReturnType<typeof vi.fn> }
    clients: {
      matchAll: ReturnType<typeof vi.fn>
      openWindow: ReturnType<typeof vi.fn>
    }
  }
}

function loadWorker(): LoadedWorker {
  const listeners = new Map<string, Listener>()
  const shown: Array<{ title: string; options: Record<string, unknown> }> = []
  const self = {
    location: { origin: 'https://pc.example.ts.net' },
    addEventListener: (type: string, listener: Listener) => listeners.set(type, listener),
    skipWaiting: vi.fn(async () => undefined),
    registration: {
      showNotification: vi.fn(async (title: string, options: Record<string, unknown>) => {
        shown.push({ title, options })
      }),
    },
    clients: {
      matchAll: vi.fn(async () => [] as unknown[]),
      openWindow: vi.fn(async () => undefined),
      claim: vi.fn(async () => undefined),
    },
  }
  const caches = {
    open: vi.fn(async () => ({ addAll: vi.fn(), put: vi.fn(), match: vi.fn() })),
    keys: vi.fn(async () => [] as string[]),
    delete: vi.fn(async () => true),
  }
  runInNewContext(SOURCE, {
    self,
    caches,
    fetch: vi.fn(),
    Response: { error: () => ({}) },
    URL,
  })
  return { listeners, shown, self }
}

function dispatchPush(listeners: Map<string, Listener>, payload: unknown): Promise<unknown> {
  let settled: Promise<unknown> | undefined
  listeners.get('push')!({
    data: { json: () => payload },
    waitUntil: (promise: Promise<unknown>) => {
      settled = promise
    },
  })
  expect(settled).toBeDefined()
  return settled!
}

function dispatchClick(
  listeners: Map<string, Listener>,
  data: Record<string, unknown>,
): { promise: Promise<unknown>; close: ReturnType<typeof vi.fn> } {
  const close = vi.fn()
  let settled: Promise<unknown> | undefined
  listeners.get('notificationclick')!({
    notification: { close, data },
    waitUntil: (promise: Promise<unknown>) => {
      settled = promise
    },
  })
  expect(settled).toBeDefined()
  return { promise: settled!, close }
}

describe('mobile service worker push handling', () => {
  it('pre-caches the first-paint theme boot script', () => {
    expect(SOURCE).toContain("'/theme-boot.js'")
  })

  it('shows an approval notification that stays on screen', async () => {
    const worker = loadWorker()
    await dispatchPush(worker.listeners, {
      id: 'n1',
      kind: 'permission',
      title: 'Fix the parser',
      body: '等待审批：Run shell command',
      url: '/s/durable-1?focus=pending',
      tag: 'session:durable-1',
    })

    expect(worker.self.registration.showNotification).toHaveBeenCalledTimes(1)
    const shown = worker.shown[0]
    expect(shown?.title).toBe('Fix the parser')
    expect(shown?.options).toMatchObject({
      body: '等待审批：Run shell command',
      tag: 'session:durable-1',
      requireInteraction: true,
      data: { url: '/s/durable-1?focus=pending', kind: 'permission' },
    })
  })

  it('keeps completion notifications dismissible', async () => {
    const worker = loadWorker()
    await dispatchPush(worker.listeners, {
      kind: 'completed',
      title: 'Fix the parser',
      body: '已完成',
      url: '/s/durable-1',
    })

    expect(worker.shown[0]?.options).toMatchObject({
      requireInteraction: false,
      data: { url: '/s/durable-1', kind: 'completed' },
    })
    expect(worker.shown[0]?.options).not.toHaveProperty('tag')
  })

  it('survives a malformed push payload', async () => {
    const worker = loadWorker()
    let settled: Promise<unknown> | undefined
    worker.listeners.get('push')!({
      data: {
        json: () => {
          throw new Error('not json')
        },
      },
      waitUntil: (promise: Promise<unknown>) => {
        settled = promise
      },
    })
    await settled

    expect(worker.shown[0]?.title).toBe('Universe 遥控')
    expect(worker.shown[0]?.options).toMatchObject({
      body: '',
      requireInteraction: false,
      data: { url: '/', kind: '' },
    })
  })

  it('focuses an existing window and posts the deep link', async () => {
    const worker = loadWorker()
    const client = {
      url: 'https://pc.example.ts.net/s/current',
      focus: vi.fn(async () => {}),
      postMessage: vi.fn(),
    }
    worker.self.clients.matchAll.mockResolvedValue([client])

    const { promise, close } = dispatchClick(worker.listeners, {
      url: '/s/durable-1?focus=pending',
    })
    await promise

    expect(close).toHaveBeenCalledTimes(1)
    expect(client.focus).toHaveBeenCalledTimes(1)
    expect(client.postMessage).toHaveBeenCalledWith({
      type: 'mobile-navigate',
      url: '/s/durable-1?focus=pending',
    })
    expect(worker.self.clients.openWindow).not.toHaveBeenCalled()
  })

  it('ignores windows from other origins', async () => {
    const worker = loadWorker()
    const foreign = {
      url: 'https://example.com/s/current',
      focus: vi.fn(async () => {}),
      postMessage: vi.fn(),
    }
    worker.self.clients.matchAll.mockResolvedValue([foreign])

    const { promise } = dispatchClick(worker.listeners, { url: '/s/durable-1' })
    await promise

    expect(foreign.focus).not.toHaveBeenCalled()
    expect(worker.self.clients.openWindow).toHaveBeenCalledWith(
      'https://pc.example.ts.net/s/durable-1',
    )
  })

  it('opens a new window when no client is running', async () => {
    const worker = loadWorker()
    const { promise } = dispatchClick(worker.listeners, { url: '/s/durable-1?focus=pending' })
    await promise

    expect(worker.self.clients.openWindow).toHaveBeenCalledWith(
      'https://pc.example.ts.net/s/durable-1?focus=pending',
    )
  })
})
