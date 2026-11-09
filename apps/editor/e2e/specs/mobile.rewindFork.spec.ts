/*---------------------------------------------------------------------------------------------
 *  Phone gateway: fork / rewind / side-task happy path over a raw WebSocket phone.
 *
 *  The echo fixture advertises + implements `session/fork` and
 *  `universe-editor/rewind_session` (ECHO_AGENT_FORK/REWIND + *_RPC), so the whole
 *  chain is real: main gateway → renderer bridge → AcpSessionService → agent.
 *
 *  Every command must leave the PC's active session alone: the phone forks and
 *  opens side tasks with `activate:false`, and rewind never activates.
 *--------------------------------------------------------------------------------------------*/

import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Page } from '@playwright/test'
import type { WorkbenchPO } from '@universe-editor/e2e-harness'
import {
  MOBILE_PROTOCOL_VERSION,
  parseServerFrame,
  serializeFrame,
  type MobileSessionRef,
  type MobileSideTaskSummary,
  type MobileTimelineMessageItem,
  type ServerFrame,
} from '@universe-editor/mobile-protocol'
import { WebSocket } from 'ws'
import {
  MOBILE_E2E_CODE,
  MOBILE_GATEWAY_PORT,
  expect,
  test,
} from '../fixtures/mobileApp.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ECHO_AGENT_PATH = resolve(__dirname, '..', '..', 'src', 'test-fixtures', 'echoAgent.cjs')
const EXPECTED_ORIGIN = `http://127.0.0.1:${MOBILE_GATEWAY_PORT}`

type CommandResultFrame = Extract<ServerFrame, { type: 'command_result' }>

function nextFrameOfType<T extends ServerFrame['type']>(
  ws: WebSocket,
  type: T,
  timeoutMs = 10_000,
  matches: (frame: Extract<ServerFrame, { type: T }>) => boolean = () => true,
): Promise<Extract<ServerFrame, { type: T }>> {
  return new Promise((resolveFrame, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', onMessage)
      reject(new Error(`timed out waiting for ${type}`))
    }, timeoutMs)
    const onMessage = (data: WebSocket.RawData): void => {
      const parsed = parseServerFrame(data.toString())
      if (!parsed.ok || parsed.value.type !== type) return
      const frame = parsed.value as Extract<ServerFrame, { type: T }>
      if (!matches(frame)) return
      clearTimeout(timer)
      ws.off('message', onMessage)
      resolveFrame(frame)
    }
    ws.on('message', onMessage)
  })
}

let nextCommandId = 0

async function sendCommand(
  ws: WebSocket,
  kind: string,
  payload: unknown,
): Promise<CommandResultFrame> {
  const requestId = `e2e-${++nextCommandId}`
  return new Promise<CommandResultFrame>((resolveResult, reject) => {
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error(`timed out waiting for command_result (${kind})`))
    }, 120_000)
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
      resolveResult(parsed.value)
    }
    ws.on('message', onMessage)
    ws.on('close', onClose)
    ws.send(serializeFrame({ type: 'command', requestId, kind, payload }))
  })
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
  ref: MobileSessionRef,
): Promise<Extract<ServerFrame, { type: 'session_snapshot' }>> {
  const snapshot = nextFrameOfType(ws, 'session_snapshot', 10_000, (frame) =>
    sameRef(frame.session.summary.ref, ref),
  )
  ws.send(serializeFrame({ type: 'subscribe_session', ref }))
  return snapshot
}

function sameRef(a: MobileSessionRef, b: MobileSessionRef): boolean {
  return a.windowId === b.windowId && a.localId === b.localId && a.durableId === b.durableId
}

async function openSettings(page: Page, workbench: WorkbenchPO): Promise<void> {
  await workbench.runCommand('workbench.action.mobile.openSettings')
  await expect(page.getByTestId('mobile-gateway-state')).toBeVisible()
}

async function waitForRunning(page: Page): Promise<string> {
  await expect.poll(async () => (await gatewayStatus(page)).state).toBe('running')
  return EXPECTED_ORIGIN
}

function gatewayStatus(page: Page) {
  return page.evaluate(() => window.__E2E__!.getMobileGatewayStatus())
}

function openSocket(origin: string): Promise<WebSocket> {
  const ws = new WebSocket(`${origin.replace(/^http/, 'ws')}/ws`, { origin })
  return new Promise((resolveSocket, reject) => {
    ws.once('open', () => resolveSocket(ws))
    ws.once('error', reject)
  })
}

async function connectRawPhone(
  page: Page,
  workbench: WorkbenchPO,
): Promise<{ ws: WebSocket; origin: string }> {
  await openSettings(page, workbench)
  const origin = await waitForRunning(page)
  await page.getByTestId('mobile-pairing-start').click()
  await expect(page.getByTestId('mobile-pairing-code')).toHaveText('1234-ABCD')

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
  await helloPromise
  return { ws, origin }
}

async function startEchoSession(page: Page, workbench: WorkbenchPO): Promise<void> {
  await workbench.waitForRestored()
  await page.evaluate(([id, p, env]) => window.__E2E__!.installAcpEchoAgent(id, p, env), [
    'echo',
    ECHO_AGENT_PATH,
    {
      ECHO_AGENT_FORK: '1',
      ECHO_AGENT_REWIND: '1',
      ECHO_AGENT_FORK_RPC: '1',
      ECHO_AGENT_REWIND_RPC: '1',
      ECHO_AGENT_LOAD_SESSION: '1',
    },
  ] as const)
  await page.evaluate(() => {
    void window.__E2E__!.runCommand('workbench.action.agent.newSession')
  })
  await expect
    .poll(() => page.evaluate(() => window.__E2E__!.getAcpSessionCount()), { timeout: 10_000 })
    .toBe(1)
  await expect
    .poll(() => page.evaluate(() => window.__E2E__!.getAcpSessionStatus()), { timeout: 10_000 })
    .toBe('idle')
}

async function sendAndWaitForReply(page: Page, text: string): Promise<void> {
  await page.evaluate((prompt) => window.__E2E__!.sendAcpPrompt(prompt), text)
  await expect
    .poll(() => page.evaluate(() => window.__E2E__!.getAcpMessages()), { timeout: 10_000 })
    .toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: 'agent', text: `echo: ${text}`, streaming: false }),
      ]),
    )
  await expect
    .poll(() => page.evaluate(() => window.__E2E__!.getAcpSessionStatus()), { timeout: 10_000 })
    .toBe('idle')
}

function activeSessionId(page: Page): Promise<string | undefined> {
  return page.evaluate(() => window.__E2E__!.getActiveAcpSessionId())
}

function sessionRefOf(result: CommandResultFrame): MobileSessionRef {
  return (result.result as { readonly ref: MobileSessionRef }).ref
}

test.describe('mobile gateway fork / rewind / side tasks', () => {
  test.describe.configure({ mode: 'default' })

  test.beforeAll(() => {
    const assets = join(__dirname, '..', '..', '..', 'mobile', 'dist', 'index.html')
    if (!existsSync(assets)) {
      throw new Error(
        `phone PWA assets are missing at ${assets}; run \`pnpm --filter @universe-editor/mobile build\``,
      )
    }
  })

  test('@p1 forks, previews and rewinds, and manages side tasks without stealing PC focus', async ({
    page,
    workbench,
  }) => {
    const { ws } = await connectRawPhone(page, workbench)
    try {
      await startEchoSession(page, workbench)
      await sendAndWaitForReply(page, 'first')
      await sendAndWaitForReply(page, 'second')

      const inbox = await subscribeInbox(ws)
      const row = inbox.sessions[0]!
      expect(row.forkSupported).toBe(true)
      expect(row.rewindSupported).toBe(true)

      const snapshot = await subscribeSession(ws, row.ref)
      expect(snapshot.session.summary.forkSupported).toBe(true)
      expect(snapshot.session.summary.rewindSupported).toBe(true)
      const userItems = snapshot.session.timeline.filter(
        (item): item is MobileTimelineMessageItem =>
          item.kind === 'message' && item.role === 'user',
      )
      expect(userItems).toHaveLength(2)
      expect(userItems[0]?.messageId).toBeTruthy()
      expect(userItems[0]?.canFork).toBe(false)
      expect(userItems[1]?.canFork).toBe(true)
      const anchor = userItems[1]?.messageId
      expect(anchor).toBeTruthy()

      const activeBefore = await activeSessionId(page)
      expect(activeBefore).toBeTruthy()

      const forked = await sendCommand(ws, 'forkSession', { ref: row.ref, messageId: anchor })
      expect(forked).toMatchObject({ ok: true })
      const forkedRef = sessionRefOf(forked)
      expect(forkedRef.durableId).toBeTruthy()
      expect(await activeSessionId(page)).toBe(activeBefore)

      const forkedSnapshot = await subscribeSession(ws, forkedRef)
      expect(forkedSnapshot.session.summary.ref).toEqual(forkedRef)
      const forkedUsers = forkedSnapshot.session.timeline.filter(
        (item): item is MobileTimelineMessageItem =>
          item.kind === 'message' && item.role === 'user',
      )
      expect(forkedUsers.map((item) => item.text)).toEqual(['first'])

      const preview = await sendCommand(ws, 'previewRewind', {
        ref: row.ref,
        messageId: anchor,
      })
      expect(preview).toMatchObject({ ok: true })
      expect(preview.result).toMatchObject({
        canRewind: true,
        filesChanged: 1,
        insertions: 2,
        deletions: 1,
      })

      const rewound = await sendCommand(ws, 'rewindSession', {
        ref: row.ref,
        messageId: anchor,
        rewindFiles: false,
      })
      expect(rewound).toMatchObject({ ok: true })
      expect(rewound.result).toMatchObject({ canRewind: true, text: 'second' })
      expect(await activeSessionId(page)).toBe(activeBefore)

      const created = await sendCommand(ws, 'createSideTask', {
        ref: row.ref,
        quote: 'follow up',
      })
      expect(created).toMatchObject({ ok: true })
      const sideRef = sessionRefOf(created)
      expect(sideRef.durableId).toBeTruthy()

      const listed = await sendCommand(ws, 'listSideTasks', { ref: row.ref })
      expect(listed).toMatchObject({ ok: true })
      const rows = listed.result as readonly MobileSideTaskSummary[]
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ id: sideRef.durableId, live: true })
      expect(rows[0]?.title.length).toBeGreaterThan(0)

      const opened = await sendCommand(ws, 'openSideTask', {
        ref: row.ref,
        sideTaskId: sideRef.durableId,
      })
      expect(opened).toMatchObject({ ok: true })
      const openedRef = sessionRefOf(opened)
      expect(openedRef).toMatchObject({ localId: expect.any(String) })
      expect(await activeSessionId(page)).toBe(activeBefore)

      const sideSnapshot = await subscribeSession(ws, openedRef)
      expect(sideSnapshot.session.summary.sideTaskOf).toBe(row.ref.durableId)

      expect(
        await sendCommand(ws, 'deleteSideTask', {
          ref: row.ref,
          sideTaskId: sideRef.durableId,
        }),
      ).toMatchObject({ ok: true })
      const afterDelete = await sendCommand(ws, 'listSideTasks', { ref: row.ref })
      expect(afterDelete).toMatchObject({ ok: true })
      expect(afterDelete.result).toEqual([])
    } finally {
      ws.close()
    }
  })
})
