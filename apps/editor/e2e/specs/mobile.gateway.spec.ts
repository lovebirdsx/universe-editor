/*---------------------------------------------------------------------------------------------
 *  Phone gateway end-to-end: PC settings page + the real PWA in a mobile browser
 *  context. Uses a cold-launch fixture because the gateway is main-process state
 *  started from env; each test binds a fresh free port (see mobileApp.ts).
 *
 *  The file runs serially (file-level mode): all tests share the one port picked
 *  by the fixture module, and `fullyParallel` would otherwise let two tests bind
 *  the same port in different workers.
 *--------------------------------------------------------------------------------------------*/

import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, devices, type Browser, type BrowserContext, type Page } from '@playwright/test'
import type { WorkbenchPO } from '@universe-editor/e2e-harness'
import {
  MOBILE_PROTOCOL_VERSION,
  parseServerFrame,
  serializeFrame,
  type MobilePermissionUpsertEvent,
  type MobileWorkspaceCandidate,
  type ServerFrame,
} from '@universe-editor/mobile-protocol'
import { WebSocket } from 'ws'
import type { E2EMobileGatewayStatus } from '../../src/shared/e2e/contract.js'
import {
  MOBILE_ASSETS_DIR,
  MOBILE_E2E_CODE,
  MOBILE_GATEWAY_PORT,
  expect,
  test,
} from '../fixtures/mobileApp.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ECHO_AGENT_PATH = resolve(__dirname, '..', '..', 'src', 'test-fixtures', 'echoAgent.cjs')

const FIXED_CODE_DISPLAY = '1234-ABCD'
const EXPECTED_ORIGIN = `http://127.0.0.1:${MOBILE_GATEWAY_PORT}`
const EXPECTED_LISTEN_ADDRESS = `127.0.0.1:${MOBILE_GATEWAY_PORT}`

type GatewayStatus = E2EMobileGatewayStatus

function gatewayStatus(page: Page): Promise<GatewayStatus> {
  return page.evaluate(() => window.__E2E__!.getMobileGatewayStatus())
}

async function openSettings(page: Page, workbench: WorkbenchPO): Promise<void> {
  await workbench.runCommand('workbench.action.mobile.openSettings')
  await expect(page.getByTestId('mobile-gateway-state')).toBeVisible()
}

async function waitForRunning(page: Page): Promise<string> {
  await expect.poll(async () => (await gatewayStatus(page)).state).toBe('running')
  const status = await gatewayStatus(page)
  const origin = status.origins[0]
  expect(origin).toBe(EXPECTED_ORIGIN)
  return origin!
}

/** Click the real "Pair new device" button and read back the fixed e2e code. */
async function startPairing(page: Page): Promise<void> {
  await page.getByTestId('mobile-pairing-start').click()
  await expect(page.getByTestId('mobile-pairing-active')).toBeVisible()
  await expect(page.getByTestId('mobile-pairing-code')).toHaveText(FIXED_CODE_DISPLAY)
}

interface PairedPhone {
  readonly browser: Browser
  readonly context: BrowserContext
  readonly phone: Page
  readonly origin: string
}

function nextFrameOfType<T extends ServerFrame['type']>(
  ws: WebSocket,
  type: T,
  timeoutMs = 10_000,
): Promise<Extract<ServerFrame, { type: T }>> {
  return new Promise((resolveFrame, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', onMessage)
      reject(new Error(`timed out waiting for ${type}`))
    }, timeoutMs)
    const onMessage = (data: WebSocket.RawData): void => {
      const parsed = parseServerFrame(data.toString())
      if (!parsed.ok) return
      if (parsed.value.type !== type) return
      clearTimeout(timer)
      ws.off('message', onMessage)
      resolveFrame(parsed.value as Extract<ServerFrame, { type: T }>)
    }
    ws.on('message', onMessage)
  })
}

type SessionDeltaEvent = Extract<ServerFrame, { type: 'session_delta' }>['events'][number]
type CommandResultFrame = Extract<ServerFrame, { type: 'command_result' }>

function collectSessionEvents(ws: WebSocket): SessionDeltaEvent[] {
  const events: SessionDeltaEvent[] = []
  ws.on('message', (data) => {
    const parsed = parseServerFrame(data.toString())
    if (!parsed.ok || parsed.value.type !== 'session_delta') return
    events.push(...parsed.value.events)
  })
  return events
}

let nextCommandId = 0

/** Send one command frame and return its `command_result` (commands run serially). */
async function sendCommand(
  ws: WebSocket,
  kind: string,
  payload: unknown,
  idempotencyKey?: string,
): Promise<CommandResultFrame> {
  const requestId = `e2e-${++nextCommandId}`
  const frame = await new Promise<CommandResultFrame>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error(`timed out waiting for command_result (${kind})`))
    }, 10_000)
    const cleanup = (): void => {
      clearTimeout(timer)
      ws.off('message', onMessage)
      ws.off('close', onClose)
    }
    const onClose = (): void => {
      cleanup()
      reject(new Error(`socket closed while waiting for ${kind}`))
    }
    const onMessage = (data: WebSocket.RawData): void => {
      const parsed = parseServerFrame(data.toString())
      if (!parsed.ok) return
      if (parsed.value.type === 'server_error') {
        cleanup()
        reject(new Error(`server_error: ${parsed.value.code} ${parsed.value.message}`))
        return
      }
      if (parsed.value.type !== 'command_result' || parsed.value.requestId !== requestId) return
      cleanup()
      resolve(parsed.value)
    }
    ws.on('message', onMessage)
    ws.on('close', onClose)
    ws.send(
      serializeFrame({
        type: 'command',
        requestId,
        kind,
        payload,
        ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
      }),
    )
  })
  return frame
}

async function subscribeInbox(
  ws: WebSocket,
): Promise<Extract<ServerFrame, { type: 'inbox_snapshot' }>> {
  const snapshot = nextFrameOfType(ws, 'inbox_snapshot')
  ws.send(serializeFrame({ type: 'subscribe_inbox' }))
  return snapshot
}

async function subscribeSession(
  ws: WebSocket,
  ref: Extract<ServerFrame, { type: 'inbox_snapshot' }>['sessions'][number]['ref'],
): Promise<Extract<ServerFrame, { type: 'session_snapshot' }>> {
  const snapshot = nextFrameOfType(ws, 'session_snapshot')
  ws.send(serializeFrame({ type: 'subscribe_session', ref }))
  return snapshot
}

/**
 * Pair a raw-WebSocket "phone" without the PWA. The settings page must already be
 * reachable; pairing starts there and the code is exchanged over the HTTP API.
 */
async function connectRawPhone(
  page: Page,
  workbench: WorkbenchPO,
): Promise<{ ws: WebSocket; origin: string }> {
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
  const helloPromise = nextFrameOfType(ws, 'hello_ok')
  ws.send(
    serializeFrame({
      type: 'hello',
      protocolVersion: MOBILE_PROTOCOL_VERSION,
      token,
      clientVersion: 'e2e',
      capabilities: ['inbox', 'commands'],
    }),
  )
  const hello = await helloPromise
  expect(hello.capabilities).toContain('commands')
  return { ws, origin }
}

async function startEchoSession(page: Page, workbench: WorkbenchPO): Promise<void> {
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
}

function openSocket(origin: string): Promise<WebSocket> {
  const ws = new WebSocket(`${origin.replace(/^http/, 'ws')}/ws`, { origin })
  return new Promise((resolveSocket, reject) => {
    ws.once('open', () => resolveSocket(ws))
    ws.once('error', reject)
  })
}

/** Pair an iPhone 13 browser context through the PWA and wait for the PC to see it online. */
async function pairPhone(page: Page, workbench: WorkbenchPO): Promise<PairedPhone> {
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
    await expect(deviceRow).toHaveCount(1)
    await expect(deviceRow).toContainText('Online')
  } catch (error) {
    await browser.close()
    throw error
  }
  return { browser, context, phone, origin }
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
      expect(allowOnce).toMatchObject({ allowedOnMobile: true })
      expect(durable).toMatchObject({ allowedOnMobile: false })

      const forbidden = await sendCommand(ws, 'resolvePermission', {
        ref: row.ref,
        requestId,
        optionId: 'allow-with-updates',
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
})

/**
 * `newSession` needs a launch workspace so the window's bridge is guaranteed to
 * exist before the command arrives (the cold fixture otherwise starts empty).
 */
test.describe('mobile gateway in a workspace', () => {
  test.use({ workspaceSeeder: { seed: () => {} } })

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

      const missing = await sendCommand(ws, 'newSession', {
        agentId: 'echo',
        workspace: { folder: 'file:///universe-editor/missing-workspace' },
      })
      expect(missing).toMatchObject({ ok: false, error: 'workspace_not_open' })
    } finally {
      ws.close()
    }
  })
})
