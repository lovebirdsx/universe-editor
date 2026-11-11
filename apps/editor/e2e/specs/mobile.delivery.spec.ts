/*---------------------------------------------------------------------------------------------
 *  Phone delivery end-to-end: a real git repository (main worktree + feature worktree +
 *  bare remote), the real git extension and the gateway. The phone previews a clean
 *  source worktree, starts the delivery, confirms the push, and then undoes it — every
 *  git write happens inside the extension, exactly like production.
 *
 *  The source worktree is the seeded workspace; the main worktree and bare remote are
 *  siblings. Absolute paths never cross the phone wire, so assertions only look at
 *  worktree names in protocol frames and inspect git state locally.
 *--------------------------------------------------------------------------------------------*/

import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Page } from '@playwright/test'
import type { WorkbenchPO } from '@universe-editor/e2e-harness'
import {
  MOBILE_PROTOCOL_VERSION,
  parseServerFrame,
  serializeFrame,
  type MobileDeliveryDetail,
  type MobileDeliveryPreview,
  type MobileDeliveryStartResult,
  type MobileSessionRef,
  type ServerFrame,
} from '@universe-editor/mobile-protocol'
import { WebSocket } from 'ws'
import { MOBILE_DELIVERY_E2E_CODE, expect, test } from '../fixtures/mobileDeliveryApp.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ECHO_AGENT_PATH = resolve(__dirname, '..', '..', 'src', 'test-fixtures', 'echoAgent.cjs')
const MAIN_WORKTREE_NAME = 'delivery-main'

function git(cwd: string, args: readonly string[]): string {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
  } catch (error) {
    const stderr =
      typeof error === 'object' && error !== null && 'stderr' in error
        ? String(error.stderr)
        : String(error)
    throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${stderr}`)
  }
}

test.describe('mobile delivery', () => {
  test.use({
    workspaceSeeder: {
      seed(dir) {
        const parent = dirname(dir)
        const mainDir = join(parent, MAIN_WORKTREE_NAME)
        const remoteDir = join(parent, 'delivery-remote.git')
        rmSync(mainDir, { recursive: true, force: true })
        rmSync(remoteDir, { recursive: true, force: true })
        mkdirSync(mainDir, { recursive: true })
        git(parent, ['init', '--bare', remoteDir])
        git(mainDir, ['init', '-b', 'main'])
        writeFileSync(join(mainDir, 'README.md'), '# delivery demo\n')
        git(mainDir, ['add', '-A'])
        git(mainDir, [
          '-c',
          'user.name=testuser',
          '-c',
          'user.email=testuser@example.com',
          'commit',
          '-m',
          'initial',
        ])
        git(mainDir, ['remote', 'add', 'origin', remoteDir])
        git(mainDir, ['push', '-u', 'origin', 'main'])

        // The seeded workspace becomes the feature worktree; git recreates the
        // directory, so remove the empty one the harness prepared.
        rmSync(dir, { recursive: true, force: true })
        git(mainDir, ['worktree', 'add', '-b', 'feature', dir])
        writeFileSync(join(dir, 'feature.txt'), 'feature\n')
        git(dir, ['add', '-A'])
        git(dir, [
          '-c',
          'user.name=testuser',
          '-c',
          'user.email=testuser@example.com',
          'commit',
          '-m',
          'feat: add feature file',
        ])
      },
    },
  })

  test('@p1 delivers a clean worktree, pushes on confirmation and undoes it', async ({
    page,
    workbench,
    launchWorkspace,
  }) => {
    test.setTimeout(240_000)
    if (launchWorkspace === undefined) throw new Error('workspace seeder did not run')
    const featureDir = launchWorkspace.dir
    const mainDir = join(dirname(featureDir), MAIN_WORKTREE_NAME)
    const remoteDir = join(dirname(featureDir), 'delivery-remote.git')

    await workbench.waitForRestored()
    await startEchoSession(page, workbench)
    const { ws } = await connectRawPhone(page, workbench)
    try {
      const inbox = await subscribeInbox(ws)
      const row = inbox.sessions.find((session) => session.agentId === 'echo')
      expect(row).toBeDefined()
      const ref = row!.ref

      const previewFrame = await sendCommand(ws, 'previewDelivery', { ref }, undefined, 60_000)
      if (!previewFrame.ok) {
        throw new Error(`previewDelivery failed: ${previewFrame.error}`)
      }
      const preview = previewFrame.result as MobileDeliveryPreview
      expect(preview.source).toMatchObject({
        worktreeName: basename(featureDir),
        dirty: false,
      })
      expect(preview.commits).toHaveLength(1)
      expect(preview.commits[0]?.subject).toBe('feat: add feature file')
      expect(preview.blockers).toEqual([])
      expect(preview.target).toMatchObject({
        mainWorktreeName: MAIN_WORKTREE_NAME,
        mainBranch: 'main',
      })

      const startFrame = await sendCommand(
        ws,
        'startDelivery',
        { ref, expectation: preview.expectation },
        undefined,
        120_000,
      )
      expect(startFrame.ok).toBe(true)
      const { deliveryId } = startFrame.result as MobileDeliveryStartResult

      await expect
        .poll(() => deliveryPhase(ws, ref, deliveryId), { timeout: 90_000 })
        .toBe('awaiting_push')

      // Nothing moves on main before the phone confirms.
      expect(git(mainDir, ['rev-parse', 'HEAD'])).toBe(git(mainDir, ['rev-parse', 'origin/main']))

      const detail = await getDelivery(ws, ref, deliveryId)
      expect(detail.summary).toMatchObject({
        phase: 'awaiting_push',
        commitCount: 1,
        canConfirmPush: true,
        canUndo: true,
      })
      expect(detail.commits).toHaveLength(1)

      const confirmFrame = await sendCommand(
        ws,
        'confirmDeliveryPush',
        { ref, deliveryId },
        undefined,
        120_000,
      )
      expect(confirmFrame.ok).toBe(true)
      await expect
        .poll(() => deliveryPhase(ws, ref, deliveryId), { timeout: 90_000 })
        .toBe('synced')

      const deliveredHead = git(remoteDir, ['rev-parse', 'main'])
      expect(git(remoteDir, ['log', '-1', '--format=%s', 'main'])).toBe('feat: add feature file')
      // The source worktree was clean and behind, so it was fast-forwarded onto main.
      expect(git(featureDir, ['rev-parse', 'HEAD'])).toBe(deliveredHead)

      const undoFrame = await sendCommand(
        ws,
        'undoDelivery',
        { ref, deliveryId },
        undefined,
        120_000,
      )
      expect(undoFrame.ok).toBe(true)
      await expect
        .poll(() => deliveryPhase(ws, ref, deliveryId), { timeout: 90_000 })
        .toBe('undone')
      const revertedHead = git(remoteDir, ['rev-parse', 'main'])
      expect(revertedHead).not.toBe(deliveredHead)
      expect(git(remoteDir, ['log', '-1', '--format=%s', 'main'])).toContain('Revert')
      expect(git(featureDir, ['rev-parse', 'HEAD'])).toBe(revertedHead)
    } finally {
      ws.close()
    }
  })
})

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

let nextCommandId = 0

async function sendCommand(
  ws: WebSocket,
  kind: string,
  payload: unknown,
  idempotencyKey?: string,
  timeoutMs = 10_000,
): Promise<Extract<ServerFrame, { type: 'command_result' }>> {
  const requestId = `delivery-e2e-${++nextCommandId}`
  return new Promise((resolveFrame, reject) => {
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
      resolveFrame(parsed.value)
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
}

async function subscribeInbox(
  ws: WebSocket,
): Promise<Extract<ServerFrame, { type: 'inbox_snapshot' }>> {
  const snapshot = nextFrameOfType(ws, 'inbox_snapshot')
  ws.send(serializeFrame({ type: 'subscribe_inbox' }))
  return snapshot
}

async function getDelivery(
  ws: WebSocket,
  ref: MobileSessionRef,
  deliveryId: string,
): Promise<MobileDeliveryDetail> {
  const result = await sendCommand(ws, 'getDelivery', { ref, deliveryId }, undefined, 20_000)
  if (!result.ok) throw new Error(`getDelivery failed: ${result.error}`)
  return result.result as MobileDeliveryDetail
}

async function deliveryPhase(
  ws: WebSocket,
  ref: MobileSessionRef,
  deliveryId: string,
): Promise<string | undefined> {
  const result = await sendCommand(ws, 'getDelivery', { ref, deliveryId }, undefined, 20_000)
  return result.ok ? (result.result as MobileDeliveryDetail).summary.phase : undefined
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
  await expect
    .poll(() => page.evaluate(() => window.__E2E__!.getAcpSessionStatus()), { timeout: 10_000 })
    .toBe('idle')
}

function gatewayStatus(page: Page) {
  return page.evaluate(() => window.__E2E__!.getMobileGatewayStatus())
}

async function connectRawPhone(
  page: Page,
  workbench: WorkbenchPO,
): Promise<{ ws: WebSocket; origin: string }> {
  await workbench.runCommand('workbench.action.mobile.openSettings')
  await expect(page.getByTestId('mobile-gateway-state')).toBeVisible()
  await expect.poll(async () => (await gatewayStatus(page)).state).toBe('running')
  const origin = (await gatewayStatus(page)).origins[0]
  if (origin === undefined) throw new Error('gateway origin missing')

  await page.getByTestId('mobile-pairing-start').click()
  await expect(page.getByTestId('mobile-pairing-active')).toBeVisible()

  const pairResponse = await fetch(`${origin}/api/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      code: MOBILE_DELIVERY_E2E_CODE,
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
      clientVersion: 'delivery-e2e',
      capabilities: ['inbox', 'commands'],
    }),
  )
  const hello = await helloPromise
  expect(hello.protocolVersion).toBe(MOBILE_PROTOCOL_VERSION)
  return { ws, origin }
}

function openSocket(origin: string): Promise<WebSocket> {
  const ws = new WebSocket(`${origin.replace(/^http/, 'ws')}/ws`, { origin })
  return new Promise((resolveSocket, reject) => {
    ws.once('open', () => resolveSocket(ws))
    ws.once('error', reject)
  })
}
