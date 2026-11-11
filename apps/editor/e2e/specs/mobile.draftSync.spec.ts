/*---------------------------------------------------------------------------------------------
 *  Phone ↔ PC composer draft sync (protocol v17). One raw-WebSocket phone covers
 *  the frame contract (ack + snapshot), the PWA phone covers the real UI path in
 *  both directions. Cold-launch fixture: the gateway is main-process state.
 *  Caret/selection is local to each client and never travels on the wire.
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

const __dirname = dirname(fileURLToPath(import.meta.url))
const ECHO_AGENT_PATH = resolve(__dirname, '..', '..', 'src', 'test-fixtures', 'echoAgent.cjs')
const FIXED_CODE_DISPLAY = '1234-ABCD'
const EXPECTED_ORIGIN = `http://127.0.0.1:${MOBILE_GATEWAY_PORT}`

type InboxRef = Extract<ServerFrame, { type: 'inbox_snapshot' }>['sessions'][number]['ref']
type SessionDeltaEvent = Extract<ServerFrame, { type: 'session_delta' }>['events'][number]

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
      if (!parsed.ok || parsed.value.type !== type) return
      clearTimeout(timer)
      ws.off('message', onMessage)
      resolveFrame(parsed.value as Extract<ServerFrame, { type: T }>)
    }
    ws.on('message', onMessage)
  })
}

function openSocket(origin: string): Promise<WebSocket> {
  const ws = new WebSocket(`${origin.replace(/^http/, 'ws')}/ws`, { origin })
  return new Promise((resolveSocket, reject) => {
    ws.once('open', () => resolveSocket(ws))
    ws.once('error', reject)
  })
}

async function openSettings(page: Page, workbench: WorkbenchPO): Promise<void> {
  await workbench.runCommand('workbench.action.mobile.openSettings')
  await expect(page.getByTestId('mobile-gateway-state')).toBeVisible()
}

async function waitForRunning(page: Page): Promise<string> {
  await expect
    .poll(async () => {
      const status = await page.evaluate(() => window.__E2E__!.getMobileGatewayStatus())
      return status.state
    })
    .toBe('running')
  return EXPECTED_ORIGIN
}

async function startPairing(page: Page): Promise<void> {
  await page.getByTestId('mobile-pairing-start').click()
  await expect(page.getByTestId('mobile-pairing-active')).toBeVisible()
  await expect(page.getByTestId('mobile-pairing-code')).toHaveText(FIXED_CODE_DISPLAY)
}

async function pairToken(origin: string, deviceName: string): Promise<string> {
  const response = await fetch(`${origin}/api/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: MOBILE_E2E_CODE, deviceName, platform: 'other' }),
  })
  expect(response.status).toBe(200)
  return ((await response.json()) as { token: string }).token
}

async function startEchoSession(page: Page, workbench: WorkbenchPO): Promise<void> {
  await workbench.waitForRestored()
  await page.evaluate(([id, path]) => window.__E2E__!.installAcpEchoAgent(id, path), [
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

async function subscribeInbox(ws: WebSocket): Promise<InboxRef> {
  const snapshot = nextFrameOfType(ws, 'inbox_snapshot')
  ws.send(serializeFrame({ type: 'subscribe_inbox' }))
  const inbox = await snapshot
  const row = inbox.sessions[0]
  if (row === undefined) throw new Error('inbox is empty')
  return row.ref
}

async function focusPcPrompt(page: Page): Promise<void> {
  await page.getByRole('tab', { name: /Echo Agent/ }).click()
  await expect(page.getByTestId('acp-prompt-drop-host')).toBeVisible({ timeout: 10_000 })
  await page.evaluate(() => {
    void window.__E2E__!.runCommand('workbench.action.agent.focusInput')
  })
  await expect
    .poll(() => page.evaluate(() => window.__E2E__!.getContextKey('acpPromptInputFocused')), {
      timeout: 5_000,
    })
    .toBe(true)
}

async function subscribeSession(
  ws: WebSocket,
  ref: InboxRef,
): Promise<Extract<ServerFrame, { type: 'session_snapshot' }>> {
  const snapshot = nextFrameOfType(ws, 'session_snapshot')
  ws.send(serializeFrame({ type: 'subscribe_session', ref }))
  return snapshot
}

async function connectRawPhone(
  page: Page,
  workbench: WorkbenchPO,
): Promise<{ ws: WebSocket; origin: string; hello: Extract<ServerFrame, { type: 'hello_ok' }> }> {
  await openSettings(page, workbench)
  const origin = await waitForRunning(page)
  await startPairing(page)
  const token = await pairToken(origin, 'E2E Phone')

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
  return { ws, origin, hello: await helloPromise }
}

interface PairedPhone {
  readonly browser: Browser
  readonly context: BrowserContext
  readonly phone: Page
  readonly origin: string
}

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
  } catch (error) {
    await browser.close()
    throw error
  }
  return { browser, context, phone, origin }
}

async function openFirstPhoneSession(phone: Page): Promise<void> {
  const row = phone.getByTestId('inbox-session-row').first()
  await expect(row).toBeVisible()
  await row.click()
  await expect(phone).toHaveURL(/\/s\//)
  await expect(phone.getByTestId('composer')).toBeVisible()
}

function collectSessionEvents(ws: WebSocket): SessionDeltaEvent[] {
  const events: SessionDeltaEvent[] = []
  ws.on('message', (data) => {
    const parsed = parseServerFrame(data.toString())
    if (!parsed.ok || parsed.value.type !== 'session_delta') return
    events.push(...parsed.value.events)
  })
  return events
}

test.describe('mobile draft sync', () => {
  test.describe.configure({ mode: 'default' })

  test.beforeAll(() => {
    if (!existsSync(join(MOBILE_ASSETS_DIR, 'index.html'))) {
      throw new Error(
        `phone PWA assets are missing at ${MOBILE_ASSETS_DIR}; run \`pnpm --filter @universe-editor/mobile build\``,
      )
    }
  })

  test('@p1 advertises draft support and applies a raw phone draft on the PC', async ({
    page,
    workbench,
  }) => {
    await startEchoSession(page, workbench)
    const { ws, hello } = await connectRawPhone(page, workbench)
    try {
      expect(hello.capabilities).toContain('draft')

      const ref = await subscribeInbox(ws)
      const snapshot = await subscribeSession(ws, ref)
      expect(snapshot.session.draft).toBeUndefined()

      const events = collectSessionEvents(ws)
      const clientUpdateId = 'draft-raw-1'
      ws.send(
        serializeFrame({
          type: 'draft_update',
          ref,
          clientUpdateId,
          draft: { text: 'typed on phone', images: [] },
        }),
      )

      await expect
        .poll(() => page.evaluate(() => window.__E2E__!.getAcpPromptText()), { timeout: 10_000 })
        .toBe('typed on phone')
      await expect
        .poll(
          () =>
            events.filter(
              (event) => event.type === 'draft_update' && event.clientUpdateId === clientUpdateId,
            ).length,
          { timeout: 10_000 },
        )
        .toBe(1)
    } finally {
      ws.close()
    }
  })

  test('@p1 mirrors a PC draft to the phone composer and back', async ({ page, workbench }) => {
    await startEchoSession(page, workbench)
    const { browser, context, phone } = await pairPhone(page, workbench)
    try {
      await openFirstPhoneSession(phone)

      await focusPcPrompt(page)

      await page.keyboard.type('draft from pc')
      const phoneInput = phone.getByTestId('composer-input')
      await expect(phoneInput).toHaveValue('draft from pc', { timeout: 10_000 })

      await phoneInput.fill('draft from phone')
      await expect
        .poll(() => page.evaluate(() => window.__E2E__!.getAcpPromptText()), { timeout: 10_000 })
        .toBe('draft from phone')
      await expect(phoneInput).toHaveValue('draft from phone')
    } finally {
      await context.close()
      await browser.close()
    }
  })

  test('@regression clears the phone composer when the PC deletes every character', async ({
    page,
    workbench,
  }) => {
    await startEchoSession(page, workbench)
    const { browser, context, phone } = await pairPhone(page, workbench)
    try {
      await openFirstPhoneSession(phone)
      await focusPcPrompt(page)

      await page.keyboard.type('clear me')
      const phoneInput = phone.getByTestId('composer-input')
      await expect(phoneInput).toHaveValue('clear me', { timeout: 10_000 })

      await page.keyboard.press('Control+A')
      await page.keyboard.press('Backspace')

      await expect(phoneInput).toHaveValue('', { timeout: 10_000 })
    } finally {
      await context.close()
      await browser.close()
    }
  })

  test('@regression keeps the phone caret when a newer PC draft arrives', async ({
    page,
    workbench,
  }) => {
    await startEchoSession(page, workbench)
    const { browser, context, phone } = await pairPhone(page, workbench)
    try {
      await openFirstPhoneSession(phone)
      await focusPcPrompt(page)

      await page.keyboard.type('abcdef')
      const phoneInput = phone.getByTestId('composer-input')
      await expect(phoneInput).toHaveValue('abcdef', { timeout: 10_000 })

      await phoneInput.evaluate((element) => {
        const textarea = element as HTMLTextAreaElement
        textarea.focus()
        textarea.setSelectionRange(2, 2)
        textarea.dispatchEvent(new Event('select', { bubbles: true }))
      })

      await page.keyboard.type('X')

      await expect(phoneInput).toHaveValue('abcdefX', { timeout: 10_000 })
      expect(
        await phoneInput.evaluate((element) => (element as HTMLTextAreaElement).selectionStart),
      ).toBe(2)
    } finally {
      await context.close()
      await browser.close()
    }
  })
})
