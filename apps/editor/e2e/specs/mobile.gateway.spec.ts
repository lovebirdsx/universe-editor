/*---------------------------------------------------------------------------------------------
 *  Phone gateway end-to-end: PC settings page + the real PWA in a mobile browser
 *  context. Uses a cold-launch fixture because the gateway is main-process state
 *  started from env; each test binds a fresh free port (see mobileApp.ts).
 *
 *  The file runs serially (file-level mode): all tests share the one port picked
 *  by the fixture module, and `fullyParallel` would otherwise let two tests bind
 *  the same port in different workers.
 *--------------------------------------------------------------------------------------------*/

import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { request as httpsRequest } from 'node:https'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkTempDir } from '@universe-editor/e2e-harness'
import { chromium, devices, type Browser, type BrowserContext, type Page } from '@playwright/test'
import type { WorkbenchPO } from '@universe-editor/e2e-harness'
import {
  MOBILE_PROTOCOL_VERSION,
  parseServerFrame,
  serializeFrame,
  type MobileConfigOptionValue,
  type MobilePermissionUpsertEvent,
  type MobilePromptRefSuggestion,
  type MobileTimelineMessageItem,
  type MobileWorkspaceCandidate,
  type ServerFrame,
} from '@universe-editor/mobile-protocol'
import { WebSocket } from 'ws'
import {
  MOBILE_ASSETS_DIR,
  MOBILE_E2E_CODE,
  MOBILE_GATEWAY_PORT,
  expect,
  test,
} from '../fixtures/mobileApp.js'
import { TLS_MOBILE_E2E_CODE, tlsTest } from '../fixtures/mobileAppTls.js'
import {
  collectSessionEvents,
  createMobileGatewayPageHelpers,
  nextFrameOfType,
  openSocket,
  sendCommand,
  subscribeInbox,
  subscribeSession,
} from './helpers/mobileGateway.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ECHO_AGENT_PATH = resolve(__dirname, '..', '..', 'src', 'test-fixtures', 'echoAgent.cjs')

const FIXED_CODE_DISPLAY = '1234-ABCD'
const EXPECTED_ORIGIN = `http://127.0.0.1:${MOBILE_GATEWAY_PORT}`
const EXPECTED_LISTEN_ADDRESS = `127.0.0.1:${MOBILE_GATEWAY_PORT}`

const { gatewayStatus, openSettings, waitForRunning, startPairing, connectRawPhone } =
  createMobileGatewayPageHelpers({
    e2eCode: MOBILE_E2E_CODE,
    pairingCodeDisplay: FIXED_CODE_DISPLAY,
    expectedOrigin: EXPECTED_ORIGIN,
  })

interface PairedPhone {
  readonly browser: Browser
  readonly context: BrowserContext
  readonly phone: Page
  readonly origin: string
}

/** Find the open workspace candidate for the seeded temp directory. */
async function findOpenWorkspace(
  ws: WebSocket,
  launchDir: string,
): Promise<MobileWorkspaceCandidate> {
  let candidate: MobileWorkspaceCandidate | undefined
  await expect
    .poll(
      async () => {
        const result = await sendCommand(ws, 'listWorkspaces', {})
        if (!result.ok) return false
        candidate = (result.result as MobileWorkspaceCandidate[]).find(
          (workspace) => workspace.isOpen && workspace.folder.endsWith(launchDir),
        )
        return candidate !== undefined
      },
      { timeout: 15_000 },
    )
    .toBe(true)
  return candidate!
}

/** Poll until the PC-side remembered cwd catches up (the durable write is debounced). */
async function expectRememberedRelativePath(
  ws: WebSocket,
  folder: string,
  expected: string,
): Promise<void> {
  await expect
    .poll(
      async () => {
        const options = await sendCommand(ws, 'getNewSessionOptions', { folder })
        return options.ok
          ? (options.result as { lastRelativePath?: string }).lastRelativePath
          : undefined
      },
      { timeout: 15_000 },
    )
    .toBe(expected)
}

/** The echo agent's `mode` select carries a `bypass` value. */
function bypassValue(
  options: Extract<ServerFrame, { type: 'session_snapshot' }>['session']['configOptions'],
): MobileConfigOptionValue | undefined {
  return options
    .find((option) => option.id === 'mode')
    ?.options?.find((value) => value.value === 'bypass')
}

/**
 * Config options arrive from the agent after `session/new`; re-subscribe until
 * the snapshot carries them so assertions never race the handshake.
 */
async function subscribeWithConfig(
  ws: WebSocket,
  ref: Extract<ServerFrame, { type: 'inbox_snapshot' }>['sessions'][number]['ref'],
): Promise<Extract<ServerFrame, { type: 'session_snapshot' }>> {
  let snapshot: Extract<ServerFrame, { type: 'session_snapshot' }> | undefined
  await expect
    .poll(
      async () => {
        snapshot = await subscribeSession(ws, ref)
        return bypassValue(snapshot.session.configOptions) !== undefined
      },
      { timeout: 10_000 },
    )
    .toBe(true)
  return snapshot!
}

async function startEchoSession(
  page: Page,
  workbench: WorkbenchPO,
  env?: Record<string, string>,
): Promise<void> {
  await workbench.waitForRestored()
  await page.evaluate(([id, p, extra]) => window.__E2E__!.installAcpEchoAgent(id, p, extra), [
    'echo',
    ECHO_AGENT_PATH,
    env,
  ] as const)
  await page.evaluate(() => {
    void window.__E2E__!.runCommand('workbench.action.agent.newSession')
  })
  await expect
    .poll(() => page.evaluate(() => window.__E2E__!.getAcpSessionCount()), { timeout: 10_000 })
    .toBe(1)
}

function openTlsSocket(origin: string): Promise<WebSocket> {
  const ws = new WebSocket(`${origin.replace(/^http/, 'ws')}/ws`, {
    origin,
    rejectUnauthorized: false,
  })
  return new Promise((resolveSocket, reject) => {
    ws.once('open', () => resolveSocket(ws))
    ws.once('error', reject)
  })
}

interface TlsResponse {
  readonly status: number
  readonly headers: Record<string, string | string[] | undefined>
  readonly body: string
}

function tlsRequest(
  origin: string,
  path: string,
  init: { method?: string; body?: string } = {},
): Promise<TlsResponse> {
  const url = new URL(path, origin)
  return new Promise((resolveResponse, reject) => {
    const request = httpsRequest(
      {
        host: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        method: init.method ?? 'GET',
        headers: init.body === undefined ? undefined : { 'content-type': 'application/json' },
        rejectUnauthorized: false,
      },
      (response) => {
        const chunks: Buffer[] = []
        response.on('data', (chunk: Buffer) => chunks.push(chunk))
        response.on('end', () =>
          resolveResponse({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        )
      },
    )
    request.on('error', reject)
    request.end(init.body)
  })
}

/** Pair an iPhone 13 browser context through the PWA and wait for the PC to see it online. */
async function pairPhone(
  page: Page,
  workbench: WorkbenchPO,
  expectedDevices = 1,
): Promise<PairedPhone> {
  await openSettings(page, workbench)
  const origin = await waitForRunning(page)
  await startPairing(page)

  const browser = await chromium.launch()
  const context = await browser.newContext({ ...devices['iPhone 13'] })
  const phone = await context.newPage()
  try {
    await phone.goto(`${origin}/pair#code=${MOBILE_E2E_CODE}`)
    await expect(phone.getByLabel('配对码')).toHaveValue(MOBILE_E2E_CODE)
    await phone.getByRole('button', { name: '开始配对' }).click()
    await expect(phone.getByText('已连接', { exact: true })).toBeVisible()
    const deviceRow = page.locator('li[data-testid^="mobile-device-"]')
    await expect(deviceRow).toHaveCount(expectedDevices)
    await expect(deviceRow.last()).toContainText('Online')
  } catch (error) {
    await browser.close()
    throw error
  }
  return { browser, context, phone, origin }
}

/** Open the single inbox row and wait for the interactive session page. */
async function openFirstPhoneSession(phone: Page): Promise<void> {
  const row = phone.getByTestId('inbox-session-row').first()
  await expect(row).toBeVisible()
  await row.click()
  await expect(phone).toHaveURL(/\/s\//)
  await expect(phone.getByTestId('composer')).toBeVisible()
}

/** Real touch pan (CDP), since mobile scrolling is a compositor gesture, not a wheel event. */
async function swipeUp(phone: Page, x: number, fromY: number, toY: number): Promise<void> {
  const cdp = await phone.context().newCDPSession(phone)
  try {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ x, y: fromY }],
    })
    for (let step = 1; step <= 10; step += 1) {
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [{ x, y: fromY + ((toY - fromY) * step) / 10 }],
      })
      await phone.waitForTimeout(16)
    }
  } finally {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await cdp.detach()
  }
}

/**
 * Read the bearer token the paired PWA persisted. The token never leaves the
 * phone; e2e uses a second socket on the same device to flip notification prefs
 * (Web Push itself cannot be exercised in headless Chromium).
 */
async function readPhoneToken(phone: Page): Promise<string> {
  const token = await phone.evaluate(async () => {
    const request = indexedDB.open('universe-mobile', 1)
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    try {
      return await new Promise<string | undefined>((resolve, reject) => {
        const transaction = db.transaction('credentials', 'readonly')
        const get = transaction.objectStore('credentials').get('device')
        get.onsuccess = () => {
          const record = get.result as { token?: unknown } | undefined
          resolve(typeof record?.token === 'string' ? record.token : undefined)
        }
        get.onerror = () => reject(get.error)
      })
    } finally {
      db.close()
    }
  })
  expect(token).toBeTruthy()
  return token!
}

/** Same device, second socket: enable notifications with alwaysNotify. */
async function enableDeviceNotifications(origin: string, token: string): Promise<WebSocket> {
  const ws = await openSocket(origin)
  const helloPromise = nextFrameOfType(ws, 'hello_ok')
  ws.send(
    serializeFrame({
      type: 'hello',
      protocolVersion: MOBILE_PROTOCOL_VERSION,
      token,
      clientVersion: 'e2e',
      capabilities: ['notifications'],
    }),
  )
  await helloPromise
  ws.send(serializeFrame({ type: 'set_notification_prefs', enabled: true, alwaysNotify: true }))
  return ws
}

test.describe('mobile gateway', () => {
  test.describe.configure({ mode: 'default' })

  test.beforeAll(() => {
    if (!existsSync(join(MOBILE_ASSETS_DIR, 'index.html'))) {
      throw new Error(
        `phone PWA assets are missing at ${MOBILE_ASSETS_DIR}; run \`pnpm --filter @universe-editor/mobile build\``,
      )
    }
  })

  test('@p0 starts the gateway and reports the real listen address', async ({
    page,
    workbench,
  }) => {
    await openSettings(page, workbench)

    await expect(page.getByTestId('mobile-gateway-state')).toHaveText('Running')
    const origin = await waitForRunning(page)

    const status = await gatewayStatus(page)
    expect(status.listenAddress).toBe(EXPECTED_LISTEN_ADDRESS)
    expect(status.origins).toEqual([EXPECTED_ORIGIN, `http://localhost:${MOBILE_GATEWAY_PORT}`])
    expect(status.connectedDeviceCount).toBe(0)
    expect(origin).toBe(EXPECTED_ORIGIN)

    await expect(page.getByTestId('mobile-gateway-listen')).toHaveText(EXPECTED_LISTEN_ADDRESS)
  })

  test('@p0 pairs a raw phone, completes hello and receives the inbox snapshot', async ({
    page,
    workbench,
  }) => {
    const { ws, hello } = await connectRawPhone(page, workbench)
    try {
      expect(hello.webBuildId).toMatch(/\.js$/)
      const snapshot = await subscribeInbox(ws)
      expect(snapshot.sessions).toEqual([])
    } finally {
      ws.close()
    }
  })

  test('@p0 pairs an iPhone and shows the empty inbox plus an online device', async ({
    page,
    workbench,
  }) => {
    const { browser, context, phone } = await pairPhone(page, workbench)
    try {
      await expect(phone.getByText('PC 上暂无进行中的 Agent 会话')).toBeVisible()
      await expect(phone.getByText('已连接', { exact: true })).toBeVisible()

      const deviceRow = page.locator('li[data-testid^="mobile-device-"]')
      await expect(deviceRow).toContainText('iPhone')
      await expect(page.getByTestId('mobile-gateway-connected')).toContainText('1 connected')
      await expect.poll(async () => (await gatewayStatus(page)).connectedDeviceCount).toBe(1)
    } finally {
      await context.close()
      await browser.close()
    }
  })

  test('@p1 pairs from the unpaired inbox guide page', async ({ page, workbench }) => {
    await openSettings(page, workbench)
    const origin = await waitForRunning(page)
    await startPairing(page)

    const browser = await chromium.launch()
    const context = await browser.newContext({ ...devices['iPhone 13'] })
    try {
      const phone = await context.newPage()
      await phone.goto(`${origin}/`)
      await expect(phone.getByText('还没有配对')).toBeVisible()
      await phone.getByLabel('配对码').fill(MOBILE_E2E_CODE)
      await phone.getByRole('button', { name: '开始配对' }).click()
      await expect(phone.getByText('已连接', { exact: true })).toBeVisible()

      const deviceRow = page.locator('li[data-testid^="mobile-device-"]')
      await expect(deviceRow).toHaveCount(1)
      await expect(deviceRow).toContainText('Online')
    } finally {
      await context.close()
      await browser.close()
    }
  })

  test('@p1 revoking the device disconnects the phone and asks it to pair again', async ({
    page,
    workbench,
  }) => {
    const { browser, context, phone } = await pairPhone(page, workbench)
    try {
      await page.locator('[data-testid^="mobile-device-revoke-"]').click()

      const dialog = page.getByRole('dialog')
      await expect(dialog).toBeVisible()
      await expect(dialog).toContainText('Revoke device')
      await dialog.getByRole('button', { name: 'Revoke' }).click()
      await expect(dialog).toBeHidden()

      await expect(phone.getByText('此设备已被吊销或凭据失效，请重新配对。')).toBeVisible()
      await expect(phone.getByText('已连接', { exact: true })).toBeHidden()
      await expect(page.locator('li[data-testid^="mobile-device-"]')).toHaveCount(0)
      await expect.poll(async () => (await gatewayStatus(page)).connectedDeviceCount).toBe(0)
    } finally {
      await context.close()
      await browser.close()
    }
  })

  test('@p1 rejects a wrong pairing code with a Chinese error', async ({ page, workbench }) => {
    await openSettings(page, workbench)
    const origin = await waitForRunning(page)
    await startPairing(page)

    const browser = await chromium.launch()
    const context = await browser.newContext({ ...devices['iPhone 13'] })
    try {
      const phone = await context.newPage()
      await phone.goto(`${origin}/pair#code=ZZZZZZZZ`)
      await phone.getByRole('button', { name: '开始配对' }).click()
      await expect(phone.getByText('配对码无效或已过期，请在 PC 上重新生成。')).toBeVisible()
      // A failed attempt must not add a device on the PC.
      await expect(page.locator('li[data-testid^="mobile-device-"]')).toHaveCount(0)
    } finally {
      await context.close()
      await browser.close()
    }
  })

  test('@p0 opens a mirrored session from the phone inbox and shows the conversation', async ({
    page,
    workbench,
  }) => {
    await workbench.waitForRestored()

    await page.evaluate(([id, p]) => window.__E2E__!.installAcpEchoAgent(id, p), [
      'echo',
      ECHO_AGENT_PATH,
    ] as const)
    await page.evaluate(() => {
      void window.__E2E__!.runCommand('workbench.action.agent.newSession')
    })
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getAcpSessionCount()), { timeout: 10_000 })
      .toBe(1)

    await page.evaluate(() => window.__E2E__!.sendAcpPrompt('hello'))
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getAcpMessages()), { timeout: 5000 })
      .toEqual([
        { role: 'user', text: 'hello', streaming: false },
        { role: 'agent', text: 'echo: hello', streaming: false },
      ])

    const { browser, context, phone } = await pairPhone(page, workbench)
    try {
      const row = phone.getByTestId('inbox-session-row').first()
      await expect(row).toBeVisible()
      await row.click()

      await expect(phone).toHaveURL(/\/s\//)
      await expect(phone.getByTestId('user-message')).toContainText('hello')
      await expect(phone.getByTestId('agent-message')).toContainText('echo: hello')
    } finally {
      await context.close()
      await browser.close()
    }
  })

  test('@regression keeps thought cards readable when the timeline overflows', async ({
    page,
    workbench,
  }) => {
    await workbench.waitForRestored()

    await page.evaluate(([id, p]) => window.__E2E__!.installAcpEchoAgent(id, p), [
      'echo',
      ECHO_AGENT_PATH,
    ] as const)
    await page.evaluate(() => {
      void window.__E2E__!.runCommand('workbench.action.agent.newSession')
    })
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getAcpSessionCount()), { timeout: 10_000 })
      .toBe(1)

    await page.evaluate(() => window.__E2E__!.sendAcpPrompt('emit-thought:2x1'))
    const longPrompt = Array.from({ length: 200 }, (_, index) => `line ${index}`).join('\n')
    await page.evaluate((text) => window.__E2E__!.sendAcpPrompt(text), longPrompt)
    await expect
      .poll(
        () =>
          page.evaluate(() =>
            window
              .__E2E__!.getAcpMessages()
              .some((message) => message.role === 'agent' && message.text.startsWith('echo: ')),
          ),
        { timeout: 10_000 },
      )
      .toBe(true)

    const { browser, context, phone } = await pairPhone(page, workbench)
    try {
      // Thoughts are filtered out in the default only-message mode; this spec
      // measures their layout, so switch the phone to full display first.
      await phone.getByRole('button', { name: '设置' }).click()
      await phone.getByTestId('session-display-full').check()
      await phone.getByRole('button', { name: '关闭', exact: true }).click()
      await openFirstPhoneSession(phone)
      const thought = phone.getByTestId('thought-item').first()
      await expect(thought).toBeAttached()
      // The timeline is taller than the phone viewport. Flex items default to
      // flex-shrink:1; a card with overflow:hidden would collapse to its borders.
      const box = await thought.boundingBox()
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(44)
    } finally {
      await context.close()
      await browser.close()
    }
  })

  test('@p1 mirrors a live ACP session through subscribe_session + session_delta', async ({
    page,
    workbench,
  }) => {
    await workbench.waitForRestored()

    await page.evaluate(([id, p]) => window.__E2E__!.installAcpEchoAgent(id, p), [
      'echo',
      ECHO_AGENT_PATH,
    ] as const)
    await page.evaluate(() => {
      void window.__E2E__!.runCommand('workbench.action.agent.newSession')
    })
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getAcpSessionCount()), { timeout: 10_000 })
      .toBe(1)

    // Start pairing only after every navigation: leaving the settings editor cancels it.
    await openSettings(page, workbench)
    const origin = await waitForRunning(page)
    await startPairing(page)

    const pairResponse = await fetch(`${origin}/api/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: MOBILE_E2E_CODE, deviceName: 'E2E Phone', platform: 'other' }),
    })
    expect(pairResponse.status).toBe(200)
    const { token } = (await pairResponse.json()) as { token: string }

    const ws = await openSocket(origin)
    try {
      const helloPromise = nextFrameOfType(ws, 'hello_ok')
      ws.send(
        serializeFrame({
          type: 'hello',
          protocolVersion: MOBILE_PROTOCOL_VERSION,
          token,
          clientVersion: 'e2e',
          capabilities: ['inbox'],
        }),
      )
      const hello = await helloPromise
      expect(hello.protocolVersion).toBe(MOBILE_PROTOCOL_VERSION)

      const inboxPromise = nextFrameOfType(ws, 'inbox_snapshot')
      ws.send(serializeFrame({ type: 'subscribe_inbox' }))
      const inbox = await inboxPromise
      expect(inbox.sessions).toHaveLength(1)
      const row = inbox.sessions[0]!
      expect(row.agentId).toBe('echo')
      expect(typeof row.ref.windowId).toBe('number')
      expect(row.ref.localId).not.toBe('')

      const snapshotPromise = nextFrameOfType(ws, 'session_snapshot')
      ws.send(serializeFrame({ type: 'subscribe_session', ref: row.ref }))
      const snapshot = await snapshotPromise
      expect(snapshot.session.summary.ref).toEqual(row.ref)
      expect(snapshot.session.timeline).toEqual([])

      const deltas: Extract<ServerFrame, { type: 'session_delta' }>[] = []
      ws.on('message', (data) => {
        const parsed = parseServerFrame(data.toString())
        if (parsed.ok && parsed.value.type === 'session_delta') deltas.push(parsed.value)
      })

      await page.evaluate(() => window.__E2E__!.sendAcpPrompt('hello'))
      await expect
        .poll(() => page.evaluate(() => window.__E2E__!.getAcpMessages()), { timeout: 5000 })
        .toEqual([
          { role: 'user', text: 'hello', streaming: false },
          { role: 'agent', text: 'echo: hello', streaming: false },
        ])

      const mirroredText = (): string[] => {
        const textById = new Map<string, string>()
        for (const delta of deltas) {
          for (const event of delta.events) {
            if (event.type === 'timeline_item_added' && event.item.kind === 'message') {
              textById.set(event.item.id, event.item.text)
            } else if (event.type === 'message_upsert') {
              const previous = textById.get(event.id) ?? ''
              textById.set(event.id, event.textReplace ?? previous + (event.textAppend ?? ''))
            }
          }
        }
        return [...textById.values()]
      }
      await expect.poll(mirroredText, { timeout: 5000 }).toEqual(['hello', 'echo: hello'])

      const completedTool = deltas
        .flatMap((delta) => delta.events)
        .flatMap((event) =>
          event.type === 'tool_call_upsert'
            ? [event.item]
            : event.type === 'timeline_item_added' && event.item.kind === 'toolCall'
              ? [event.item]
              : [],
        )
        .find((item) => item.status === 'completed')
      expect(completedTool).toMatchObject({ title: 'echo' })
      const toolCallId = completedTool?.id ?? ''

      const commandPromise = nextFrameOfType(ws, 'command_result')
      ws.send(
        serializeFrame({
          type: 'command',
          requestId: 'detail-1',
          kind: 'getToolCallDetail',
          payload: { ref: row.ref, toolCallId },
        }),
      )
      const command = await commandPromise
      expect(command).toMatchObject({ requestId: 'detail-1', ok: true })
      expect(command.result).toMatchObject({ id: toolCallId, title: 'echo', text: 'hello' })
    } finally {
      ws.close()
    }
  })

  test('@p1 runs a prompt sent from the phone against the PC session', async ({
    page,
    workbench,
  }) => {
    await page.evaluate(([id, p]) => window.__E2E__!.installAcpEchoAgent(id, p), [
      'echo',
      ECHO_AGENT_PATH,
    ] as const)
    const { ws } = await connectRawPhone(page, workbench)
    try {
      await startEchoSession(page, workbench)
      const inbox = await subscribeInbox(ws)
      const row = inbox.sessions[0]
      expect(row?.agentId).toBe('echo')

      const result = await sendCommand(ws, 'sendPrompt', {
        ref: row!.ref,
        text: 'phone hello',
      })
      expect(result).toMatchObject({ ok: true })

      await expect
        .poll(() => page.evaluate(() => window.__E2E__!.getAcpMessages()), { timeout: 5000 })
        .toEqual([
          { role: 'user', text: 'phone hello', streaming: false },
          { role: 'agent', text: 'echo: phone hello', streaming: false },
        ])
    } finally {
      ws.close()
    }
  })

  test.describe('prompt refs', () => {
    test.use({
      workspaceSeeder: {
        seed(dir) {
          mkdirSync(join(dir, 'src'), { recursive: true })
          writeFileSync(join(dir, 'src', 'a.ts'), 'export const a = 1\n')
        },
      },
    })

    test('@p1 completes workspace files and forwards a structured ref', async ({
      page,
      workbench,
    }) => {
      await startEchoSession(page, workbench)
      const { ws } = await connectRawPhone(page, workbench)
      try {
        const inbox = await subscribeInbox(ws)
        const ref = inbox.sessions[0]!.ref

        const result = await sendCommand(ws, 'searchPromptRefs', {
          ref,
          trigger: '@',
          query: 'a',
        })
        expect(result).toMatchObject({ ok: true })
        const entries = (result.result as { entries: readonly MobilePromptRefSuggestion[] }).entries
        const file = entries.find((entry) => entry.kind === 'file' && entry.label === 'src/a.ts')
        expect(file).toBeDefined()
        expect(file?.uri).toMatch(/^file:\/\//)

        const text = 'report-prompt-blocks @src/a.ts'
        const sent = await sendCommand(ws, 'sendPrompt', {
          ref,
          text,
          refs: [{ ...file!, start: text.indexOf('@'), end: text.length }],
        })
        expect(sent).toMatchObject({ ok: true })

        await expect
          .poll(
            () =>
              page.evaluate(() => {
                const messages = window.__E2E__!.getAcpMessages()
                return (
                  [...messages].reverse().find((m) => m.role === 'agent' && m.text.startsWith('['))
                    ?.text ?? ''
                )
              }),
            { timeout: 10_000 },
          )
          .toContain('"resource_link"')

        const blocks = await page.evaluate(() => {
          const messages = window.__E2E__!.getAcpMessages()
          const agent = [...messages]
            .reverse()
            .find((m) => m.role === 'agent' && m.text.startsWith('['))
          return JSON.parse(agent!.text) as Array<Record<string, unknown>>
        })
        const link = blocks.find((block) => block['type'] === 'resource_link')
        expect(link).toMatchObject({ type: 'resource_link', name: 'src/a.ts' })
        expect(String(link?.['uri'])).toContain('src/a.ts')
        expect(
          blocks
            .filter((block) => block['type'] === 'text')
            .map((block) => String(block['text']))
            .join('\n'),
        ).not.toContain('@src/a.ts')
      } finally {
        ws.close()
      }
    })

    test('@p1 completes and sends an @ ref from the phone UI', async ({ page, workbench }) => {
      await startEchoSession(page, workbench)
      const { browser, context, phone } = await pairPhone(page, workbench)
      try {
        await openFirstPhoneSession(phone)
        const input = phone.getByTestId('composer-input')
        const panel = phone.getByTestId('composer-ref-panel')
        await input.focus()
        await input.fill('report-prompt-blocks @a')

        const option = panel.getByTestId('composer-ref-option').filter({ hasText: 'src/a.ts' })
        await expect(option).toBeVisible()
        await option.click()
        await expect(input).toHaveValue('report-prompt-blocks @src/a.ts')
        await expect(panel).toHaveCount(0)

        await phone.getByTestId('composer-send').click()
        await expect
          .poll(
            () =>
              page.evaluate(() => {
                const messages = window.__E2E__!.getAcpMessages()
                return (
                  [...messages].reverse().find((m) => m.role === 'agent' && m.text.startsWith('['))
                    ?.text ?? ''
                )
              }),
            { timeout: 10_000 },
          )
          .toContain('"name":"src/a.ts"')
      } finally {
        await context.close()
        await browser.close()
      }
    })
  })

  test('@p1 arbitrates a permission request from the phone', async ({ page, workbench }) => {
    await page.evaluate(([id, p]) => window.__E2E__!.installAcpEchoAgent(id, p), [
      'echo',
      ECHO_AGENT_PATH,
    ] as const)
    const { ws } = await connectRawPhone(page, workbench)
    try {
      await startEchoSession(page, workbench)
      const inbox = await subscribeInbox(ws)
      const row = inbox.sessions[0]!
      await subscribeSession(ws, row.ref)
      const events = collectSessionEvents(ws)

      // The prompt blocks until the permission is answered, so do not await it.
      await page.evaluate(() => {
        void window.__E2E__!.sendAcpPrompt('approve-shell')
      })
      await expect(page.getByTestId('acp-permission-card')).toBeVisible({ timeout: 10_000 })

      let permission: MobilePermissionUpsertEvent['permission'] | undefined
      await expect
        .poll(
          () => {
            permission = events.find(
              (event): event is MobilePermissionUpsertEvent => event.type === 'permission_upsert',
            )?.permission
            return permission?.requestId
          },
          { timeout: 10_000 },
        )
        .toBeTruthy()
      const requestId = permission!.requestId
      const allowOnce = permission!.options.find((option) => option.optionId === 'allow-once')
      const durable = permission!.options.find((option) => option.optionId === 'allow-with-updates')
      expect(allowOnce).toBeDefined()
      expect(durable).toBeDefined()

      const forbidden = await sendCommand(ws, 'resolvePermission', {
        ref: row.ref,
        requestId,
        optionId: 'never-offered',
      })
      expect(forbidden).toMatchObject({ ok: false, error: 'forbidden_operation' })
      await expect(page.getByTestId('acp-permission-card')).toBeVisible()

      const resolved = await sendCommand(ws, 'resolvePermission', {
        ref: row.ref,
        requestId,
        optionId: 'allow-once',
      })
      expect(resolved).toMatchObject({ ok: true })
      await expect(page.getByTestId('acp-permission-card')).toBeHidden()

      await expect
        .poll(() => page.evaluate(() => window.__E2E__!.getAcpMessages()), { timeout: 5000 })
        .toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              role: 'agent',
              text: expect.stringContaining('approve-shell result:'),
            }),
          ]),
        )

      const stale = await sendCommand(ws, 'resolvePermission', {
        ref: row.ref,
        requestId,
        optionId: 'allow-once',
      })
      expect(stale).toMatchObject({ ok: false, error: 'stale_request' })

      await expect
        .poll(
          () =>
            events.find(
              (event) => event.type === 'permission_cleared' && event.requestId === requestId,
            ),
          { timeout: 5000 },
        )
        .toMatchObject({ reason: 'selected', source: 'mobile' })
    } finally {
      ws.close()
    }
  })

  test('@p1 lets the phone switch bypass and grant durable permissions', async ({
    page,
    workbench,
  }) => {
    const { ws, hello } = await connectRawPhone(page, workbench)
    try {
      expect(hello).not.toHaveProperty('trusted')

      await startEchoSession(page, workbench, { ECHO_AGENT_CONFIG_OPTIONS: '1' })
      const inbox = await subscribeInbox(ws)
      const row = inbox.sessions[0]!
      const initial = await subscribeWithConfig(ws, row.ref)
      expect(bypassValue(initial.session.configOptions)).toEqual({
        value: 'bypass',
        label: 'bypassPermissions (auto-approve everything)',
      })

      const events = collectSessionEvents(ws)
      const switched = await sendCommand(ws, 'setConfigOption', {
        ref: row.ref,
        configId: 'mode',
        value: 'bypass',
      })
      expect(switched).toMatchObject({ ok: true })
      await expect
        .poll(
          () => {
            const latest = [...events]
              .reverse()
              .find((event) => event.type === 'config_options_snapshot')
            return latest?.type === 'config_options_snapshot'
              ? latest.options.find((option) => option.id === 'mode')?.currentValue
              : undefined
          },
          { timeout: 5000 },
        )
        .toBe('bypassPermissions (auto-approve everything)')

      await page.evaluate(() => {
        void window.__E2E__!.sendAcpPrompt('approve-shell')
      })
      await expect(page.getByTestId('acp-permission-card')).toBeVisible({ timeout: 10_000 })

      let permission: MobilePermissionUpsertEvent['permission'] | undefined
      await expect
        .poll(
          () => {
            permission = events.find(
              (event): event is MobilePermissionUpsertEvent => event.type === 'permission_upsert',
            )?.permission
            return permission?.requestId
          },
          { timeout: 10_000 },
        )
        .toBeTruthy()
      const durable = permission!.options.find((option) => option.optionId === 'allow-with-updates')
      expect(durable).toBeDefined()

      const approved = await sendCommand(ws, 'resolvePermission', {
        ref: row.ref,
        requestId: permission!.requestId,
        optionId: 'allow-with-updates',
      })
      expect(approved).toMatchObject({ ok: true })
      await expect(page.getByTestId('acp-permission-card')).toBeHidden()
    } finally {
      ws.close()
    }
  })

  test('@p0 sends a prompt from the phone UI and mirrors the reply', async ({
    page,
    workbench,
  }) => {
    await startEchoSession(page, workbench)
    const { browser, context, phone } = await pairPhone(page, workbench)
    try {
      await openFirstPhoneSession(phone)

      const input = phone.getByTestId('composer-input')
      await input.fill('phone hello')
      await phone.getByTestId('composer-send').click()

      await expect
        .poll(() => page.evaluate(() => window.__E2E__!.getAcpMessages()), { timeout: 5000 })
        .toEqual([
          { role: 'user', text: 'phone hello', streaming: false },
          { role: 'agent', text: 'echo: phone hello', streaming: false },
        ])
      await expect(phone.getByTestId('user-message').last()).toContainText('phone hello')
      await expect(phone.getByTestId('agent-message').last()).toContainText('echo: phone hello')

      // Enter submits like the send button; an empty draft consumes it without
      // leaving a newline behind.
      await input.fill('enter hello')
      await input.press('Enter')
      await expect(input).toHaveValue('')
      await expect
        .poll(() => page.evaluate(() => window.__E2E__!.getAcpMessages()), { timeout: 5000 })
        .toEqual([
          { role: 'user', text: 'phone hello', streaming: false },
          { role: 'agent', text: 'echo: phone hello', streaming: false },
          { role: 'user', text: 'enter hello', streaming: false },
          { role: 'agent', text: 'echo: enter hello', streaming: false },
        ])
      await input.press('Enter')
      await expect(input).toHaveValue('')

      // Modified Enter falls through to the textarea, so Shift+Enter inserts a
      // newline and the next plain Enter submits the multi-line draft.
      await input.pressSequentially('line one')
      await input.press('Shift+Enter')
      await input.pressSequentially('line two')
      await expect(input).toHaveValue('line one\nline two')
      await input.press('Enter')

      await expect
        .poll(() => page.evaluate(() => window.__E2E__!.getAcpMessages()), { timeout: 5000 })
        .toEqual([
          { role: 'user', text: 'phone hello', streaming: false },
          { role: 'agent', text: 'echo: phone hello', streaming: false },
          { role: 'user', text: 'enter hello', streaming: false },
          { role: 'agent', text: 'echo: enter hello', streaming: false },
          { role: 'user', text: 'line one\nline two', streaming: false },
          { role: 'agent', text: 'echo: line one\nline two', streaming: false },
        ])
    } finally {
      await context.close()
      await browser.close()
    }
  })

  test('@p0 suggests slash commands on the phone and inserts the picked one', async ({
    page,
    workbench,
  }) => {
    await startEchoSession(page, workbench, { ECHO_AGENT_COMMANDS: '1' })
    const { browser, context, phone } = await pairPhone(page, workbench)
    try {
      await openFirstPhoneSession(phone)

      const input = phone.getByTestId('composer-input')
      const panel = phone.getByTestId('composer-command-panel')
      // available_commands_update arrives asynchronously; the "/" button only
      // renders once the list is non-empty, so it is the ready signal.
      await expect(phone.getByTestId('composer-slash')).toBeVisible()
      await input.focus()
      await input.fill('/')
      await expect(panel).toBeVisible()
      await expect(panel.getByTestId('composer-command-option')).toHaveCount(3)

      await input.fill('/di')
      await expect(panel.getByTestId('composer-command-option')).toHaveCount(1)
      await expect(panel).toContainText('/diff')

      await panel.getByTestId('composer-command-option').first().click()
      await expect(input).toHaveValue('/diff ')
      await expect(panel).toHaveCount(0)
      await expect(input).toBeFocused()
    } finally {
      await context.close()
      await browser.close()
    }
  })

  test('@p0 sends a photo and a file attachment from the phone UI', async ({ page, workbench }) => {
    await startEchoSession(page, workbench, { ECHO_AGENT_IMAGE: '1' })
    const { browser, context, phone } = await pairPhone(page, workbench)
    try {
      await openFirstPhoneSession(phone)
      await expect(phone.getByTestId('composer-attach')).toBeVisible()

      // 1×1 transparent PNG so the phone can actually decode the thumbnail.
      const png = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
        'base64',
      )
      await phone.getByTestId('composer-attachment-input').setInputFiles({
        name: 'shot.png',
        mimeType: 'image/png',
        buffer: png,
      })
      await expect(
        phone.locator('[data-testid="composer-attachment-image"].composer__chip--uploaded'),
      ).toBeVisible()

      const composerImage = phone.locator('[data-testid="composer-attachment-image"]')
      await expect(composerImage.locator('img')).toHaveAttribute('src', /^blob:/)
      await composerImage.getByTestId('composer-attachment-image-button').click()
      await expect(phone.getByTestId('image-preview')).toBeVisible()
      await expect(phone.getByTestId('image-preview-image')).toHaveAttribute('src', /^blob:/)
      await phone.getByTestId('image-preview-close').click()
      await expect(phone.getByTestId('image-preview')).toHaveCount(0)

      await phone.getByTestId('composer-attachment-input').setInputFiles({
        name: 'notes.txt',
        mimeType: 'text/plain',
        buffer: Buffer.from('hello phone'),
      })
      await expect(
        phone.locator('[data-testid="composer-attachment-file"].composer__chip--uploaded'),
      ).toBeVisible()
      await expect(
        phone
          .locator('[data-testid="composer-attachment-file"]')
          .getByTestId('composer-attachment-image-button'),
      ).toHaveCount(0)

      await phone.getByTestId('composer-input').fill('report-prompt-blocks')
      const send = phone.getByTestId('composer-send')
      await expect(send).toBeEnabled()
      await send.click()

      await expect
        .poll(
          () =>
            page.evaluate(() => {
              const messages = window.__E2E__!.getAcpMessages()
              return [...messages].reverse().find((m) => m.role === 'agent')?.text ?? ''
            }),
          { timeout: 10_000 },
        )
        .toContain('"resource_link"')

      const blocks = await page.evaluate(() => {
        const messages = window.__E2E__!.getAcpMessages()
        const agent = [...messages]
          .reverse()
          .find((m) => m.role === 'agent' && m.text.startsWith('['))
        return JSON.parse(agent!.text) as Array<Record<string, unknown>>
      })
      const image = blocks.find((block) => block['type'] === 'image')
      expect(image).toMatchObject({
        type: 'image',
        mimeType: 'image/png',
        mobileAttachment: { kind: 'image', name: 'shot.png' },
      })
      expect(Number(image?.['dataLength'])).toBeGreaterThan(0)
      const link = blocks.find((block) => block['type'] === 'resource_link')
      expect(link).toMatchObject({
        type: 'resource_link',
        name: 'notes.txt',
        mimeType: 'text/plain',
        size: 11,
        mobileAttachment: { kind: 'file', name: 'notes.txt', size: 11 },
      })
      expect(String(link?.['uri'])).toMatch(/^file:\/\//)
      expect(String(link?.['uri'])).toContain('notes.txt')

      const userMessage = phone.getByTestId('user-message').last()
      await expect(userMessage.getByTestId('user-attachments')).toBeVisible()
      await expect(userMessage.getByTestId('user-attachment-file')).toContainText('notes.txt')
      await expect(userMessage.getByTestId('user-attachment-image').locator('img')).toHaveAttribute(
        'src',
        /^blob:/,
      )
      await expect(userMessage).not.toContainText('[包含附件]')

      await userMessage.getByTestId('user-attachment-image-button').click()
      await expect(phone.getByTestId('image-preview')).toBeVisible()
      await expect(phone.getByTestId('image-preview-image')).toHaveAttribute('src', /^blob:/)
      await expect
        .poll(() =>
          phone.evaluate(() => document.documentElement.classList.contains('is-scroll-locked')),
        )
        .toBe(true)
      await phone.getByTestId('image-preview-close').click()
      await expect(phone.getByTestId('image-preview')).toHaveCount(0)
      await expect
        .poll(() =>
          phone.evaluate(() => document.documentElement.classList.contains('is-scroll-locked')),
        )
        .toBe(false)
    } finally {
      await context.close()
      await browser.close()
    }
  })

  test('@p0 previews agent reply images on the phone', async ({ page, workbench }) => {
    await startEchoSession(page, workbench)
    const { browser, context, phone } = await pairPhone(page, workbench)
    try {
      await openFirstPhoneSession(phone)
      const input = phone.getByTestId('composer-input')

      await input.fill('report-reply-image')
      await phone.getByTestId('composer-send').click()

      const acpImage = phone.getByTestId('message-image').last()
      await expect(acpImage).toBeVisible({ timeout: 10_000 })
      await expect(acpImage.locator('img')).toHaveAttribute('src', /^blob:/)
      await acpImage.click()
      await expect(phone.getByTestId('image-preview')).toBeVisible()
      await expect(phone.getByTestId('image-preview-image')).toHaveAttribute('src', /^blob:/)
      await phone.keyboard.press('Escape')
      await expect(phone.getByTestId('image-preview')).toHaveCount(0)

      await input.fill('report-markdown-image')
      await phone.getByTestId('composer-send').click()

      const markdownImage = phone.getByTestId('markdown-image').last()
      await expect(markdownImage).toBeVisible({ timeout: 10_000 })
      await expect(markdownImage.locator('img')).toHaveAttribute('src', /^data:image\/png/)
      await markdownImage.click()
      await expect(phone.getByTestId('image-preview')).toBeVisible()
      await phone.getByTestId('image-preview-close').click()
      await expect(phone.getByTestId('image-preview')).toHaveCount(0)
    } finally {
      await context.close()
      await browser.close()
    }
  })

  test('@p1 shows a foreground notification for a permission and routes the toast', async ({
    page,
    workbench,
  }) => {
    // Web Push is not exercised here: headless Chromium has no usable push
    // service. The phone stays foregrounded, so the gateway sends an in-app
    // `notification` frame over its visible WebSocket instead.
    const { browser, context, phone, origin } = await pairPhone(page, workbench)
    let prefsSocket: WebSocket | undefined
    try {
      const token = await readPhoneToken(phone)
      prefsSocket = await enableDeviceNotifications(origin, token)
      await expect
        .poll(
          async () =>
            (await page.evaluate(() => window.__E2E__!.listMobileDevices()))[0]
              ?.notificationsEnabled,
          { timeout: 10_000 },
        )
        .toBe(true)
      await expect(page.locator('[data-testid^="mobile-device-notifications-"]')).toContainText(
        'Notifications: on',
      )

      await startEchoSession(page, workbench)
      await expect(phone.getByTestId('inbox-session-row').first()).toBeVisible({
        timeout: 10_000,
      })

      await page.evaluate(() => {
        void window.__E2E__!.sendAcpPrompt('approve-shell')
      })
      await expect(page.getByTestId('acp-permission-card')).toBeVisible({ timeout: 10_000 })

      const toast = phone.getByTestId('notification-toast')
      await expect(toast).toBeVisible({ timeout: 10_000 })
      await expect(toast).toContainText('等待审批：ls -la ~/.codex/sessions')

      await toast.getByRole('button').first().click()
      await expect(phone).toHaveURL(/\/s\//)
      await expect(phone.getByTestId('permission-sheet')).toBeVisible({ timeout: 10_000 })
      // The prompt is still pending on the PC; the phone only navigated.
      await expect(page.getByTestId('acp-permission-card')).toBeVisible()
    } finally {
      if (prefsSocket !== undefined && prefsSocket.readyState === WebSocket.OPEN) {
        // Turn notifications off before teardown: the gateway then stops the
        // attention-only bridge and drops its event subscription, so the
        // window does not report a leftover Disposable at the leak gate.
        prefsSocket.send(serializeFrame({ type: 'set_notification_prefs', enabled: false }))
        await expect
          .poll(
            async () =>
              (await page.evaluate(() => window.__E2E__!.listMobileDevices()))[0]
                ?.notificationsEnabled,
            { timeout: 10_000 },
          )
          .toBe(false)
        await page.waitForTimeout(200)
      }
      prefsSocket?.close()
      await context.close()
      await browser.close()
    }
  })

  test('@p1 approves a pending permission from the phone UI and clears the PC card', async ({
    page,
    workbench,
  }) => {
    // Pair first: starting a session switches the PC to the ACP view, and pairing
    // is cancelled when the settings editor loses focus.
    const { browser, context, phone } = await pairPhone(page, workbench)
    try {
      await startEchoSession(page, workbench)
      await openFirstPhoneSession(phone)

      await page.evaluate(() => {
        void window.__E2E__!.sendAcpPrompt('approve-shell')
      })
      await expect(page.getByTestId('acp-permission-card')).toBeVisible({ timeout: 10_000 })

      const sheet = phone.getByTestId('permission-sheet')
      await expect(sheet).toBeVisible({ timeout: 10_000 })
      // Durable grants are offered to the phone just like on the PC.
      await expect(phone.locator('[data-option-id="allow-with-updates"]')).toHaveCount(1)

      await phone.locator('[data-option-id="allow-with-updates"]').click()

      await expect(page.getByTestId('acp-permission-card')).toBeHidden({ timeout: 10_000 })
      await expect(phone.getByTestId('permission-sheet')).toBeHidden()
      await expect
        .poll(() => page.evaluate(() => window.__E2E__!.getAcpMessages()), { timeout: 5000 })
        .toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              role: 'agent',
              text: expect.stringContaining('approve-shell result:'),
            }),
          ]),
        )
    } finally {
      await context.close()
      await browser.close()
    }
  })
})

/**
 * `newSession` needs a launch workspace so the window's bridge is guaranteed to
 * exist before the command arrives (the cold fixture otherwise starts empty).
 */
test.describe('mobile gateway in a workspace', () => {
  test.use({
    workspaceSeeder: {
      seed(dir) {
        mkdirSync(join(dir, 'packages', 'demo'), { recursive: true })
      },
    },
  })

  test('@p1 creates a session in an open workspace from the phone', async ({
    page,
    workbench,
    launchWorkspace,
  }) => {
    await page.evaluate(([id, p]) => window.__E2E__!.installAcpEchoAgent(id, p), [
      'echo',
      ECHO_AGENT_PATH,
    ] as const)
    const { ws } = await connectRawPhone(page, workbench)
    try {
      let candidate: MobileWorkspaceCandidate | undefined
      await expect
        .poll(
          async () => {
            const result = await sendCommand(ws, 'listWorkspaces', {})
            if (!result.ok) return false
            candidate = (result.result as MobileWorkspaceCandidate[]).find(
              (workspace) => workspace.isOpen && workspace.folder.endsWith(launchWorkspace!.dir),
            )
            return candidate !== undefined
          },
          { timeout: 15_000 },
        )
        .toBe(true)

      const agents = await sendCommand(ws, 'listAgents', {})
      expect(agents.result).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: 'echo', isDefault: true })]),
      )

      const rootListing = await sendCommand(ws, 'listDirectory', { folder: candidate!.folder })
      expect(rootListing).toMatchObject({ ok: true })
      expect(rootListing.result).toMatchObject({
        relativePath: '',
        entries: expect.arrayContaining([{ name: 'packages', relativePath: 'packages' }]),
      })
      expect(rootListing.result).not.toHaveProperty('parentRelativePath')

      const packages = await sendCommand(ws, 'listDirectory', {
        folder: candidate!.folder,
        relativePath: 'packages',
      })
      expect(packages).toMatchObject({ ok: true })
      expect(packages.result).toMatchObject({
        relativePath: 'packages',
        parentRelativePath: '',
        entries: [{ name: 'demo', relativePath: 'packages/demo' }],
      })

      const escape = await sendCommand(ws, 'listDirectory', {
        folder: candidate!.folder,
        relativePath: '../outside',
      })
      expect(escape).toMatchObject({ ok: false, error: 'bad_request' })

      const created = await sendCommand(ws, 'newSession', {
        agentId: 'echo',
        workspace: { folder: candidate!.folder },
      })
      expect(created).toMatchObject({ ok: true })
      const ref = (created.result as { ref: { windowId: number; localId: string } }).ref
      expect(typeof ref.windowId).toBe('number')
      expect(ref.localId).not.toBe('')

      const snapshot = await subscribeSession(ws, ref)
      expect(snapshot.session.summary.agentId).toBe('echo')

      const createdSubdir = await sendCommand(
        ws,
        'newSession',
        {
          agentId: 'echo',
          workspace: { folder: candidate!.folder, relativePath: 'packages/demo' },
        },
        undefined,
        30_000,
      )
      expect(createdSubdir).toMatchObject({ ok: true })
      const subRef = (createdSubdir.result as { ref: { windowId: number; localId: string } }).ref
      const subSnapshot = await subscribeSession(ws, subRef)
      expect(subSnapshot.session.summary.agentId).toBe('echo')
      expect(subSnapshot.session.summary.cwd?.replace(/\\/g, '/')).toMatch(/packages\/demo$/)

      const missing = await sendCommand(ws, 'newSession', {
        agentId: 'echo',
        workspace: { folder: 'file:///universe-editor/missing-workspace' },
      })
      expect(missing).toMatchObject({ ok: false, error: 'workspace_not_open' })
    } finally {
      ws.close()
    }
  })

  test('@p1 creates a session from the phone new-session page', async ({ page, workbench }) => {
    await page.evaluate(([id, p]) => window.__E2E__!.installAcpEchoAgent(id, p), [
      'echo',
      ECHO_AGENT_PATH,
    ] as const)
    const { browser, context, phone } = await pairPhone(page, workbench)
    try {
      await phone.getByTestId('new-session-fab').click()
      await expect(phone).toHaveURL(/\/new$/)

      await expect(phone.getByTestId('new-session-agent-trigger')).toContainText('Echo Agent', {
        timeout: 10_000,
      })
      const workspaceTrigger = phone.getByTestId('new-session-workspace-trigger')
      await expect(workspaceTrigger).toContainText('已打开')

      await workspaceTrigger.click()
      const workspaceSheet = phone.getByTestId('new-session-workspace-sheet')
      await expect(workspaceSheet).toBeVisible()
      await expect(workspaceSheet.getByTestId('new-session-workspace-search')).toBeVisible()

      const selected = workspaceSheet.locator(
        '[data-testid="new-session-workspace"][aria-selected="true"]',
      )
      await expect(selected).toContainText('已打开')
      await selected.click()
      await expect(workspaceSheet).toHaveCount(0)

      await expect(phone.getByTestId('new-session-submit')).toBeEnabled()

      await phone.getByTestId('new-session-submit').click()

      await expect(phone).toHaveURL(/\/s\//, { timeout: 15_000 })
      await expect(phone.getByTestId('composer')).toBeVisible()
      await expect
        .poll(() => page.evaluate(() => window.__E2E__!.getAcpSessionCount()), {
          timeout: 15_000,
        })
        .toBe(1)
    } finally {
      await context.close()
      await browser.close()
    }
  })

  test('@p1 creates a session in a chosen subdirectory from the phone new-session page', async ({
    page,
    workbench,
  }) => {
    await page.evaluate(([id, p]) => window.__E2E__!.installAcpEchoAgent(id, p), [
      'echo',
      ECHO_AGENT_PATH,
    ] as const)
    const { browser, context, phone } = await pairPhone(page, workbench)
    try {
      await phone.getByTestId('new-session-fab').click()
      await expect(phone).toHaveURL(/\/new$/)
      await expect(phone.getByTestId('new-session-workspace-trigger')).toContainText('已打开', {
        timeout: 10_000,
      })

      await phone.getByTestId('new-session-directory-trigger').click()
      const sheet = phone.getByTestId('new-session-directory-sheet')
      await expect(sheet).toBeVisible()

      const packages = sheet.locator(
        '[data-testid="new-session-directory-entry"][data-relative-path="packages"]',
      )
      await expect(packages).toBeVisible({ timeout: 10_000 })
      await packages.click()
      const demo = sheet.locator(
        '[data-testid="new-session-directory-entry"][data-relative-path="packages/demo"]',
      )
      await expect(demo).toBeVisible()
      await demo.click()
      await expect(sheet.getByTestId('new-session-directory-select')).toBeEnabled()
      await sheet.getByTestId('new-session-directory-select').click()
      await expect(sheet).toHaveCount(0)
      await expect(phone.getByTestId('new-session-directory-trigger')).toContainText(
        'packages/demo',
      )

      await phone.getByTestId('new-session-submit').click()
      await expect(phone).toHaveURL(/\/s\//, { timeout: 15_000 })
      await expect(phone.getByTestId('composer')).toBeVisible()
      await expect
        .poll(() => page.evaluate(() => window.__E2E__!.getAcpSessionCount()), {
          timeout: 15_000,
        })
        .toBe(1)
    } finally {
      await context.close()
      await browser.close()
    }
  })

  /**
   * The workspace picker is a modal overlay; a pan on it used to scroll the page
   * behind (visible through the dim backdrop) instead of the sheet list.
   */
  test('@p1 workspace picker keeps the page behind it still while panning', async ({
    page,
    workbench,
  }) => {
    await page.evaluate(([id, p]) => window.__E2E__!.installAcpEchoAgent(id, p), [
      'echo',
      ECHO_AGENT_PATH,
    ] as const)
    const { browser, context, phone } = await pairPhone(page, workbench)
    try {
      // Compact phone viewport. The form fits it now, so the document overflow
      // that makes this test meaningful is set up explicitly below.
      await phone.setViewportSize({ width: 390, height: 480 })
      await phone.getByTestId('new-session-fab').click()
      const trigger = phone.getByTestId('new-session-workspace-trigger')
      await expect(trigger).toContainText('已打开', { timeout: 10_000 })

      // Without the initial-prompt textarea the form fits the viewport, so the
      // document would not scroll and the backdrop-pan assertion below would be
      // vacuous. Pad the root: the scroll lock only proves something while the
      // page behind could otherwise scroll. `overflow: hidden` keeps
      // scrollHeight intact, so the check below still holds with the sheet open.
      await phone.evaluate(() => {
        document.documentElement.style.minHeight = `${window.innerHeight * 2}px`
      })
      await trigger.click()

      const sheet = phone.getByTestId('new-session-workspace-sheet')
      await expect(sheet).toBeVisible()
      const sheetBox = await sheet.boundingBox()
      expect(sheetBox).not.toBeNull()
      expect(await phone.evaluate(() => window.scrollY)).toBe(0)
      expect(
        await phone.evaluate(() => document.documentElement.scrollHeight > window.innerHeight),
      ).toBe(true)

      // Pan the dim backdrop above the sheet: the page behind must not move.
      await swipeUp(phone, 195, Math.max(20, sheetBox!.y - 40), 20)
      await expect.poll(() => phone.evaluate(() => window.scrollY)).toBe(0)

      // A long list must scroll inside the sheet, never by moving the page.
      // The fixture exposes a single workspace, so clone rows to model the real
      // list (open windows + recent workspaces) that overflows the 80dvh cap.
      await phone.evaluate(() => {
        const list = document.querySelector(
          '[data-testid="new-session-workspace-sheet"] .choice-list',
        )
        const first = list?.firstElementChild
        if (list === null || first === null || first === undefined) {
          throw new Error('workspace list is empty')
        }
        for (let index = 0; index < 30; index += 1) {
          const clone = first.cloneNode(true) as HTMLElement
          clone.setAttribute('data-testid', 'injected-workspace')
          clone.textContent = `Injected workspace ${index}`
          list.append(clone)
        }
      })
      const content = phone.locator('[data-testid="new-session-workspace-sheet"] .sheet__content')
      const contentBox = await content.boundingBox()
      expect(contentBox).not.toBeNull()
      const { clientHeight, scrollHeight } = await content.evaluate((node) => ({
        clientHeight: node.clientHeight,
        scrollHeight: node.scrollHeight,
      }))
      expect(scrollHeight).toBeGreaterThan(clientHeight)

      await swipeUp(phone, 195, contentBox!.y + contentBox!.height - 30, contentBox!.y + 30)
      await expect.poll(() => content.evaluate((node) => node.scrollTop)).toBeGreaterThan(0)
      expect(await phone.evaluate(() => window.scrollY)).toBe(0)
    } finally {
      await context.close()
      await browser.close()
    }
  })
})

/**
 * New-session options: the remembered cwd lives PC-side in the workspace state
 * bucket, and project roots come from the workspace settings layers. The seeder
 * writes both layers so Project winning over `.vscode` and outside-the-workspace
 * absolute roots being dropped are part of the assertion.
 */
test.describe('mobile gateway new-session options', () => {
  test.describe.configure({ mode: 'default' })

  test.use({
    workspaceSeeder: {
      seed(dir) {
        mkdirSync(join(dir, 'packages', 'demo'), { recursive: true })
        mkdirSync(join(dir, 'packages', 'other'), { recursive: true })
        mkdirSync(join(dir, '.universe-editor'), { recursive: true })
        writeFileSync(
          join(dir, '.universe-editor', 'settings.json'),
          JSON.stringify({
            'acp.projectRoots': ['packages/demo', join(dir, '..', 'outside-root')],
          }),
        )
        mkdirSync(join(dir, '.vscode'), { recursive: true })
        writeFileSync(
          join(dir, '.vscode', 'settings.json'),
          JSON.stringify({ 'acp.projectRoots': ['packages/other'] }),
        )
      },
    },
  })

  test('@p1 reads project roots and remembers the created directory', async ({
    page,
    workbench,
    launchWorkspace,
  }) => {
    await page.evaluate(([id, p]) => window.__E2E__!.installAcpEchoAgent(id, p), [
      'echo',
      ECHO_AGENT_PATH,
    ] as const)
    const { ws } = await connectRawPhone(page, workbench)
    try {
      const workspace = await findOpenWorkspace(ws, launchWorkspace!.dir)

      const options = await sendCommand(ws, 'getNewSessionOptions', { folder: workspace.folder })
      expect(options).toMatchObject({ ok: true })
      expect(options.result).toEqual({ projectRoots: ['packages/demo'] })

      const unknown = await sendCommand(ws, 'getNewSessionOptions', {
        folder: 'file:///universe-editor/missing-workspace',
      })
      expect(unknown).toMatchObject({ ok: false, error: 'workspace_not_open' })

      const created = await sendCommand(
        ws,
        'newSession',
        {
          agentId: 'echo',
          workspace: { folder: workspace.folder, relativePath: 'packages/other' },
        },
        undefined,
        30_000,
      )
      expect(created).toMatchObject({ ok: true })
      const ref = (created.result as { ref: { windowId: number; localId: string } }).ref
      const snapshot = await subscribeSession(ws, ref)
      expect(snapshot.session.summary.cwd?.replace(/\\/g, '/')).toMatch(/packages\/other$/)

      await expectRememberedRelativePath(ws, workspace.folder, 'packages/other')
    } finally {
      ws.close()
    }
  })

  test('@p1 inherits the remembered directory and jumps to a project root from the phone', async ({
    page,
    workbench,
    launchWorkspace,
  }) => {
    test.setTimeout(90_000)
    await page.evaluate(([id, p]) => window.__E2E__!.installAcpEchoAgent(id, p), [
      'echo',
      ECHO_AGENT_PATH,
    ] as const)
    const { ws } = await connectRawPhone(page, workbench)
    const { browser, context, phone } = await pairPhone(page, workbench, 2)
    try {
      const workspace = await findOpenWorkspace(ws, launchWorkspace!.dir)

      // Seed the PC-side memory through the same bridge the phone uses.
      const seeded = await sendCommand(
        ws,
        'newSession',
        {
          agentId: 'echo',
          workspace: { folder: workspace.folder, relativePath: 'packages/other' },
        },
        undefined,
        30_000,
      )
      expect(seeded).toMatchObject({ ok: true })
      await expectRememberedRelativePath(ws, workspace.folder, 'packages/other')

      await phone.getByTestId('new-session-fab').click()
      await expect(phone).toHaveURL(/\/new$/)
      const trigger = phone.getByTestId('new-session-directory-trigger')
      await expect(trigger).toContainText('packages/other', { timeout: 15_000 })

      await trigger.click()
      const sheet = phone.getByTestId('new-session-directory-sheet')
      await expect(sheet).toBeVisible()
      const projectRoot = sheet.locator(
        '[data-testid="new-session-directory-project-root"][data-relative-path="packages/demo"]',
      )
      await expect(projectRoot).toBeVisible()
      await projectRoot.click()

      // The shortcut only navigates; the user confirms with the select button.
      await expect(sheet).toBeVisible()
      await expect(sheet.getByTestId('new-session-directory-path')).toContainText('packages/demo')
      await expect(sheet.getByTestId('new-session-directory-select')).toBeEnabled()
      await sheet.getByTestId('new-session-directory-select').click()
      await expect(sheet).toHaveCount(0)
      await expect(trigger).toContainText('packages/demo')

      await phone.getByTestId('new-session-submit').click()
      await expect(phone).toHaveURL(/\/s\//, { timeout: 15_000 })
      await expect(phone.getByTestId('composer')).toBeVisible()

      await expectRememberedRelativePath(ws, workspace.folder, 'packages/demo')
    } finally {
      ws.close()
      await context.close()
      await browser.close()
    }
  })
})

test.describe('mobile gateway fork/rewind guards', () => {
  test.describe.configure({ mode: 'default' })

  test('@p1 rejects fork, rewind and side tasks when the agent lacks the capabilities', async ({
    page,
    workbench,
  }) => {
    await page.evaluate(([id, p]) => window.__E2E__!.installAcpEchoAgent(id, p), [
      'echo',
      ECHO_AGENT_PATH,
    ] as const)
    const { ws } = await connectRawPhone(page, workbench)
    try {
      await startEchoSession(page, workbench)
      const inbox = await subscribeInbox(ws)
      const row = inbox.sessions[0]!

      expect(await sendCommand(ws, 'forkSession', { ref: row.ref })).toMatchObject({
        ok: false,
        error: 'unsupported_by_agent',
      })
      expect(
        await sendCommand(ws, 'previewRewind', { ref: row.ref, messageId: 'missing' }),
      ).toMatchObject({ ok: false, error: 'unsupported_by_agent' })
      expect(await sendCommand(ws, 'createSideTask', { ref: row.ref })).toMatchObject({
        ok: false,
        error: 'unsupported_by_agent',
      })
    } finally {
      ws.close()
    }
  })

  test('@p1 rejects bogus and first-turn fork anchors', async ({ page, workbench }) => {
    const { ws } = await connectRawPhone(page, workbench)
    try {
      await startEchoSession(page, workbench, { ECHO_AGENT_FORK: '1' })
      await page.evaluate(() => window.__E2E__!.sendAcpPrompt('hello'))
      await expect
        .poll(() => page.evaluate(() => window.__E2E__!.getAcpMessages()), { timeout: 10_000 })
        .toEqual(
          expect.arrayContaining([
            expect.objectContaining({ role: 'agent', text: 'echo: hello', streaming: false }),
          ]),
        )
      await expect
        .poll(() => page.evaluate(() => window.__E2E__!.getAcpSessionStatus()), {
          timeout: 10_000,
        })
        .toBe('idle')

      const inbox = await subscribeInbox(ws)
      const row = inbox.sessions[0]!
      const snapshot = await subscribeSession(ws, row.ref)
      const anchor = snapshot.session.timeline.find(
        (item): item is MobileTimelineMessageItem =>
          item.kind === 'message' && item.role === 'user',
      )
      expect(anchor?.messageId).toBeTruthy()
      expect(anchor?.canFork).toBe(false)

      expect(
        await sendCommand(ws, 'forkSession', { ref: row.ref, messageId: 'not-an-anchor' }),
      ).toMatchObject({ ok: false, error: 'invalid_anchor' })
      expect(
        await sendCommand(ws, 'forkSession', { ref: row.ref, messageId: anchor!.messageId }),
      ).toMatchObject({ ok: false, error: 'invalid_anchor' })
    } finally {
      ws.close()
    }
  })

  test('@p1 rejects a fork while the session is running', async ({ page, workbench }) => {
    const dir = mkTempDir('ue2-mobile-fork-gate-')
    const releasePath = join(dir, 'release')
    const { ws } = await connectRawPhone(page, workbench)
    try {
      await startEchoSession(page, workbench, {
        ECHO_AGENT_FORK: '1',
        ECHO_AGENT_TURN_END_GATE: releasePath,
      })
      await page.evaluate(() => {
        // The turn-end gate only holds streaming directives (finishTurn).
        void window.__E2E__!.sendAcpPrompt('emit-thought:1x1')
      })
      await expect
        .poll(() => page.evaluate(() => window.__E2E__!.getAcpSessionStatus()), {
          timeout: 10_000,
        })
        .toBe('running')

      const inbox = await subscribeInbox(ws)
      const row = inbox.sessions[0]!
      expect(await sendCommand(ws, 'forkSession', { ref: row.ref })).toMatchObject({
        ok: false,
        error: 'session_busy',
      })

      writeFileSync(releasePath, '')
      await expect
        .poll(() => page.evaluate(() => window.__E2E__!.getAcpSessionStatus()), {
          timeout: 10_000,
        })
        .toBe('idle')
    } finally {
      if (!existsSync(releasePath)) writeFileSync(releasePath, '')
      ws.close()
    }
  })
})

/**
 * Regression: a recent-only workspace is opened by the gateway first, and the
 * session must be created in that NEW window. Main registers the reverse bridge
 * before `loadURL`, so the command used to race the fresh renderer's channel
 * registration and time out (workspace opened, no session).
 */
test.describe('mobile gateway recent workspace', () => {
  test.describe.configure({ mode: 'default' })

  test('@regression creates a session after opening a recent-only workspace', async ({
    page,
    workbench,
    electronApp,
    scratchDir,
  }) => {
    test.setTimeout(90_000)
    await workbench.waitForRestored()

    // The window the gateway opens for the recent workspace reads its agent
    // config from USER settings at startup (Memory scope is per-window).
    await page.evaluate(
      ([agentPath]) =>
        window.__E2E__!.runCommand('_workbench.updateConfiguration', 'acp.agents', [
          { id: 'echo', name: 'Echo Agent', command: 'node', args: [agentPath] },
        ]),
      [ECHO_AGENT_PATH] as const,
    )
    await page.evaluate(() =>
      window.__E2E__!.runCommand('_workbench.updateConfiguration', 'acp.defaultAgentId', 'echo'),
    )
    // The update resolves before settings.json necessarily hits disk; sending
    // the phone command earlier would race the new window onto the real default
    // agent (same flush race as the deep-link spec).
    const userDataDir = await electronApp.evaluate(({ app }) => app.getPath('userData'))
    await expect
      .poll(
        () => {
          try {
            const parsed = JSON.parse(
              readFileSync(join(userDataDir, 'settings.json'), 'utf8'),
            ) as Record<string, unknown>
            const agents = parsed['acp.agents'] as Array<{ id?: string }> | undefined
            return (
              parsed['acp.defaultAgentId'] === 'echo' &&
              Boolean(agents?.some((agent) => agent.id === 'echo'))
            )
          } catch {
            return false
          }
        },
        { timeout: 10_000, message: 'echo agent config should be flushed to settings.json' },
      )
      .toBe(true)

    // Make the folder recent-only: opening it adds it to the recents; closing
    // it leaves no window holding the folder, so the gateway opens a new one.
    const dir = realpathSync.native(scratchDir('universe-editor-e2e-mobile-recent-'))
    const posixDir = dir.replace(/\\/g, '/')
    await workbench.openWorkspace(dir)
    await expect.poll(() => workbench.getCurrentWorkspacePath()).toBe(posixDir)
    await page.evaluate(() => window.__E2E__!.closeWorkspace())
    await expect.poll(() => workbench.getCurrentWorkspacePath()).toBeUndefined()
    await expect.poll(() => workbench.getRecentWorkspacePaths()).toContain(posixDir)

    const { ws } = await connectRawPhone(page, workbench)
    try {
      // The real PWA subscribes to the inbox right after hello. This matters:
      // it makes the hub want streaming before the new window exists, so its
      // subscribe/startStreaming frames race the fresh renderer exactly like a
      // real phone.
      await subscribeInbox(ws)

      const name = basename(posixDir)
      let candidate: MobileWorkspaceCandidate | undefined
      await expect
        .poll(
          async () => {
            const result = await sendCommand(ws, 'listWorkspaces', {})
            candidate = result.ok
              ? (result.result as MobileWorkspaceCandidate[]).find(
                  (workspace) => !workspace.isOpen && workspace.name === name,
                )
              : undefined
            return candidate !== undefined
          },
          { timeout: 15_000 },
        )
        .toBe(true)

      const created = await sendCommand(
        ws,
        'newSession',
        { agentId: 'echo', workspace: { folder: candidate!.folder } },
        undefined,
        30_000,
      )
      expect(created).toMatchObject({ ok: true })
      const ref = (created.result as { ref: { windowId: number; localId: string } }).ref
      expect(typeof ref.windowId).toBe('number')
      expect(ref.localId).not.toBe('')

      const snapshot = await subscribeSession(ws, ref)
      expect(snapshot.session.summary.agentId).toBe('echo')

      // Streaming from the NEW window must be wired even though the inbox was
      // subscribed before that window booted. Without the readiness resync the
      // hub believes it started streaming, so no delta ever reaches the phone.
      const deltas: Extract<ServerFrame, { type: 'session_delta' }>[] = []
      ws.on('message', (data) => {
        const parsed = parseServerFrame(data.toString())
        if (parsed.ok && parsed.value.type === 'session_delta') deltas.push(parsed.value)
      })
      const prompt = await sendCommand(ws, 'sendPrompt', { ref, text: 'hello' })
      expect(prompt).toMatchObject({ ok: true })

      const mirroredText = (): string[] => {
        const textById = new Map<string, string>()
        for (const delta of deltas) {
          for (const event of delta.events) {
            if (event.type === 'timeline_item_added' && event.item.kind === 'message') {
              textById.set(event.item.id, event.item.text)
            } else if (event.type === 'message_upsert') {
              const previous = textById.get(event.id) ?? ''
              textById.set(event.id, event.textReplace ?? previous + (event.textAppend ?? ''))
            }
          }
        }
        return [...textById.values()]
      }
      await expect.poll(mirroredText, { timeout: 10_000 }).toEqual(['hello', 'echo: hello'])
    } finally {
      ws.close()
    }
  })
})

tlsTest.describe('mobile gateway LAN HTTPS', () => {
  tlsTest.describe.configure({ mode: 'default' })

  tlsTest(
    '@p1 serves the LAN tier over self-signed HTTPS and pairs a phone',
    async ({ page, workbench }) => {
      await openSettings(page, workbench)
      await expect.poll(async () => (await gatewayStatus(page)).state).toBe('running')

      const status = await gatewayStatus(page)
      const origin = status.origins[0]
      expect(origin).toMatch(/^https:\/\/127\.0\.0\.1:\d+$/u)
      expect(status.certificate?.fingerprint).toMatch(/^[0-9a-f]{64}$/u)
      expect(status.certificate?.addresses).toContain('127.0.0.1')
      expect(status.capabilities).toEqual({ installable: false, push: false })

      const shell = await tlsRequest(origin!, '/pair')
      expect(shell.status).toBe(200)
      expect(shell.body).toContain('<!doctype html>')
      expect(shell.headers['strict-transport-security']).toBe('max-age=31536000')
      expect(shell.headers['content-security-policy']).toContain("frame-ancestors 'none'")

      await startPairing(page)
      const paired = await tlsRequest(origin!, '/api/pair', {
        method: 'POST',
        body: JSON.stringify({
          code: TLS_MOBILE_E2E_CODE,
          deviceName: 'TLS Phone',
          platform: 'other',
        }),
      })
      expect(paired.status).toBe(200)
      const { token } = JSON.parse(paired.body) as { token: string }

      const ws = await openTlsSocket(origin!)
      try {
        const helloPromise = nextFrameOfType(ws, 'hello_ok')
        ws.send(
          serializeFrame({
            type: 'hello',
            protocolVersion: MOBILE_PROTOCOL_VERSION,
            token,
            clientVersion: 'e2e-tls',
            capabilities: ['inbox'],
          }),
        )
        expect((await helloPromise).capabilities).toContain('inbox')
        expect((await subscribeInbox(ws)).sessions).toEqual([])
      } finally {
        ws.close()
      }
    },
  )
})
