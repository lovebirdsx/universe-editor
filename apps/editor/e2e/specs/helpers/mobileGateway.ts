/*---------------------------------------------------------------------------------------------
 *  Shared phone-gateway helpers: raw-WebSocket "phone" pairing, inbox/session
 *  subscription and command frames. Kept out of the spec files so the
 *  background-mode suite can drive the same real gateway without importing a
 *  file that registers Playwright tests.
 *--------------------------------------------------------------------------------------------*/

import { expect, type Page } from '@playwright/test'
import type { WorkbenchPO } from '@universe-editor/e2e-harness'
import {
  MOBILE_PROTOCOL_VERSION,
  parseServerFrame,
  serializeFrame,
  type ServerFrame,
} from '@universe-editor/mobile-protocol'
import { WebSocket } from 'ws'
import type { E2EMobileGatewayStatus } from '../../../src/shared/e2e/contract.js'

export type GatewayStatus = E2EMobileGatewayStatus
export type CommandResultFrame = Extract<ServerFrame, { type: 'command_result' }>
export type SessionDeltaEvent = Extract<ServerFrame, { type: 'session_delta' }>['events'][number]
export type InboxSnapshot = Extract<ServerFrame, { type: 'inbox_snapshot' }>
export type SessionSnapshot = Extract<ServerFrame, { type: 'session_snapshot' }>

export interface MobileGatewayPageConfig {
  /** Fixed one-time pairing code exposed by `UNIVERSE_MOBILE_E2E_CODE`. */
  readonly e2eCode: string
  /** Human-formatted code the PC settings page renders (e.g. `1234-ABCD`). */
  readonly pairingCodeDisplay: string
  /** Loopback origin the gateway is expected to serve on (`http://127.0.0.1:<port>`). */
  readonly expectedOrigin: string
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
  timeoutMs = 10_000,
): Promise<CommandResultFrame> {
  const requestId = `e2e-${++nextCommandId}`
  const frame = await new Promise<CommandResultFrame>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error(`timed out waiting for command_result (${kind})`))
    }, timeoutMs)
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

async function subscribeInbox(ws: WebSocket): Promise<InboxSnapshot> {
  const snapshot = nextFrameOfType(ws, 'inbox_snapshot')
  ws.send(serializeFrame({ type: 'subscribe_inbox' }))
  return snapshot
}

async function subscribeSession(
  ws: WebSocket,
  ref: InboxSnapshot['sessions'][number]['ref'],
): Promise<SessionSnapshot> {
  const snapshot = nextFrameOfType(ws, 'session_snapshot')
  ws.send(serializeFrame({ type: 'subscribe_session', ref }))
  return snapshot
}

function openSocket(origin: string): Promise<WebSocket> {
  const ws = new WebSocket(`${origin.replace(/^http/, 'ws')}/ws`, { origin })
  return new Promise((resolveSocket, reject) => {
    ws.once('open', () => resolveSocket(ws))
    ws.once('error', reject)
  })
}

/**
 * Page-level helpers bound to one suite's pairing constants. The factory keeps
 * call sites identical (`connectRawPhone(page, workbench)`) while letting the
 * background-mode suite reuse the same primitives with its own port/code.
 */
export function createMobileGatewayPageHelpers(config: MobileGatewayPageConfig) {
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
    expect(origin).toBe(config.expectedOrigin)
    return origin!
  }

  /** Click the real "Pair new device" button and read back the fixed e2e code. */
  async function startPairing(page: Page): Promise<void> {
    // A previous pairing in the same session leaves the editor on the success
    // notice, which offers "Pair another device" instead of the idle button.
    const trigger = page.locator(
      '[data-testid="mobile-pairing-start"], [data-testid="mobile-pairing-another"]',
    )
    await trigger.click()
    await expect(page.getByTestId('mobile-pairing-active')).toBeVisible()
    await expect(page.getByTestId('mobile-pairing-code')).toHaveText(config.pairingCodeDisplay)
  }

  /**
   * Pair a raw-WebSocket "phone" without the PWA. The settings page must already
   * be reachable; pairing starts there and the code is exchanged over the HTTP API.
   */
  async function connectRawPhone(
    page: Page,
    workbench: WorkbenchPO,
  ): Promise<{
    ws: WebSocket
    origin: string
    hello: Extract<ServerFrame, { type: 'hello_ok' }>
  }> {
    await openSettings(page, workbench)
    const origin = await waitForRunning(page)
    await startPairing(page)

    const pairResponse = await fetch(`${origin}/api/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        code: config.e2eCode,
        deviceName: 'E2E Phone',
        platform: 'other',
      }),
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
    return { ws, origin, hello }
  }

  return { gatewayStatus, openSettings, waitForRunning, startPairing, connectRawPhone }
}

export {
  collectSessionEvents,
  nextFrameOfType,
  openSocket,
  sendCommand,
  subscribeInbox,
  subscribeSession,
}
