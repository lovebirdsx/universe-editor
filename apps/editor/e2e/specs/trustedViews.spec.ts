/*---------------------------------------------------------------------------------------------
 *  Trusted views (`contributes.trustedViews`) end-to-end.
 *
 *  A development-path extension (implicitly trusted) exercises the whole
 *  renderer/host round trip: a sidebar view mounts its browser-ESM component,
 *  `ctx.request` reaches the provider and the provider `postEvent` reaches the
 *  component; `context.trustedViews.openEditor` opens a restore-capable editor tab; a
 *  crashing component degrades to an error placeholder without taking the
 *  workbench down; and an extension-host restart remounts the component with a
 *  fresh session.
 *
 *  A user-installed .vsix (NOT trusted, startup-activated) proves the trust
 *  gate: no view, one notification per session, and "Trust and Load" writes the
 *  User setting and applies the contribution without a reload. The startup
 *  activation additionally covers a provider announced before trust (the
 *  renderer must defer and replay it once the view is registered).
 *
 *  A self-launched pair of cold boots sharing one userData proves the editor tab
 *  is serialized and re-resolved after a real restart.
 *
 *  Tag note: these cold-launch + extension-host boot paths are @p1 for the same
 *  reason as smoke.extensionDev (a spawned host is slower and more
 *  environment-sensitive than the core @p0 path).
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs'
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Locator, Page } from '@playwright/test'
import {
  createColdAppTest,
  closeApp,
  evaluateWhenRestored,
  expectNoLeaks,
  launchApp,
  mkTempDir,
  seedBaselineUserData,
  waitForProbe,
  WorkbenchPO,
} from '@universe-editor/e2e-harness'
import { createVsix } from '@universe-editor/extension-packaging'
import { expect } from '../fixtures/electronApp.js'

const APP_ROOT = path.resolve(import.meta.dirname, '..', '..')
const MAIN_ENTRY = path.resolve(APP_ROOT, 'out', 'main', 'index.js')
const REPO_ROOT = path.resolve(APP_ROOT, '..', '..')
const EXTENSION_API_URL = pathToFileURL(
  path.resolve(REPO_ROOT, 'packages', 'extension-api', 'dist', 'index.js'),
).href

const TRUSTED_EXT_ID = 'acme.e2e-trusted-views'
const STATUS_VIEW = 'acme.e2e.status'
const DETAIL_VIEW = 'acme.e2e.detail'
const BROKEN_VIEW = 'acme.e2e.broken'
const OPEN_DETAIL_COMMAND = 'acme.e2e.openDetail'

const UNTRUSTED_EXT_NAME = 'e2e-untrusted-tools'
const UNTRUSTED_EXT_ID = `acme.${UNTRUSTED_EXT_NAME}`
const UNTRUSTED_VIEW = 'acme.e2e.untrusted'
const UNTRUSTED_DISPLAY_NAME = 'E2E Untrusted Tools'
const TRUST_SETTING = 'extensions.trustedViewExtensions'

// --- fixture materialization -------------------------------------------------

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function writeModule(root: string, relative: string, source: string): void {
  const file = path.join(root, relative)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, source, 'utf8')
}

/** `import { commands }` against the built API shim (bridged at runtime). */
function apiImport(names: string): string {
  return `import { ${names} } from ${JSON.stringify(EXTENSION_API_URL)}\n`
}

function trustedExtensionSource(): string {
  return `${apiImport('commands')}
export function activate(context) {
  context.subscriptions.push(
    context.trustedViews.registerProvider(${JSON.stringify(STATUS_VIEW)}, {
      handleRequest(session, method, args) {
        if (method !== 'ping') throw new Error('unknown method: ' + method)
        const reply = 'pong:' + String(args[0])
        session.postEvent('pong', { reply })
        return reply
      },
    }),
    context.trustedViews.registerProvider(${JSON.stringify(DETAIL_VIEW)}, {
      handleRequest(_session, method, args) {
        if (method !== 'ping') throw new Error('unknown method: ' + method)
        return 'pong:' + String(args[0])
      },
    }),
    commands.registerCommand(${JSON.stringify(OPEN_DETAIL_COMMAND)}, async (options) => {
      const opts = options || {}
      await context.trustedViews.openEditor(${JSON.stringify(DETAIL_VIEW)}, {
        key: opts.key || 'default',
        title: opts.title,
        state: opts.state,
      })
    }),
  )
}
`
}

function brokenExtensionSource(): string {
  return `export function activate(context) {
  context.subscriptions.push(
    context.trustedViews.registerProvider(${JSON.stringify(BROKEN_VIEW)}, {}),
  )
}
`
}

const STATUS_COMPONENT = `
const runtime = globalThis[Symbol.for('universe-editor.trustedViews.runtime')]
if (!runtime) throw new Error('trusted view runtime is missing')
const { React } = runtime
export default function StatusView({ context }) {
  const [reply, setReply] = React.useState('pending')
  const [event, setEvent] = React.useState('none')
  React.useEffect(() => {
    const subscription = context.onEvent((name, data) => {
      const detail = data && data.reply !== undefined ? data.reply : JSON.stringify(data)
      setEvent(name + '=' + String(detail))
    })
    let cancelled = false
    context.request('ping', 'hello').then(
      (value) => { if (!cancelled) setReply(String(value)) },
      (error) => { if (!cancelled) setReply('error:' + String(error && error.message ? error.message : error)) },
    )
    return () => {
      cancelled = true
      subscription.dispose()
    }
  }, [context])
  return React.createElement(
    'div',
    {
      'data-testid': 'e2e-trusted-status',
      'data-session-id': context.sessionId,
      'data-extension-id': context.extensionId,
      'data-view-id': context.viewId,
    },
    React.createElement('span', { 'data-testid': 'e2e-status-reply' }, reply),
    React.createElement('span', { 'data-testid': 'e2e-status-event' }, event),
  )
}
`

const DETAIL_COMPONENT = `
const runtime = globalThis[Symbol.for('universe-editor.trustedViews.runtime')]
if (!runtime) throw new Error('trusted view runtime is missing')
const { React } = runtime
export default function DetailView({ context }) {
  const state = context.state || {}
  const [reply, setReply] = React.useState('pending')
  React.useEffect(() => {
    context.setTitle('Detail: ' + String(state.mode || 'none'))
  }, [context])
  React.useEffect(() => {
    let cancelled = false
    context.request('ping', 'detail').then(
      (value) => { if (!cancelled) setReply(String(value)) },
      (error) => { if (!cancelled) setReply('error:' + String(error && error.message ? error.message : error)) },
    )
    return () => { cancelled = true }
  }, [context])
  return React.createElement(
    'div',
    {
      'data-testid': 'e2e-trusted-detail',
      'data-session-id': context.sessionId,
      'data-state': JSON.stringify(context.state),
      'data-location': context.location,
    },
    React.createElement('span', { 'data-testid': 'e2e-detail-reply' }, reply),
  )
}
`

const BROKEN_COMPONENT = `throw new Error('trusted view fixture exploded at import')\n`

const UNTRUSTED_COMPONENT = `
const runtime = globalThis[Symbol.for('universe-editor.trustedViews.runtime')]
if (!runtime) throw new Error('trusted view runtime is missing')
const { React } = runtime
export default function UntrustedView({ context }) {
  const [reply, setReply] = React.useState('pending')
  React.useEffect(() => {
    let cancelled = false
    context.request('ping', 'untrusted').then(
      (value) => { if (!cancelled) setReply(String(value)) },
      (error) => { if (!cancelled) setReply('error:' + String(error && error.message ? error.message : error)) },
    )
    return () => { cancelled = true }
  }, [context])
  return React.createElement(
    'div',
    { 'data-testid': 'e2e-untrusted', 'data-session-id': context.sessionId },
    React.createElement('span', { 'data-testid': 'e2e-untrusted-reply' }, reply),
  )
}
`

const UNTRUSTED_EXTENSION_SOURCE = `export function activate(context) {
  context.subscriptions.push(
    context.trustedViews.registerProvider(${JSON.stringify(UNTRUSTED_VIEW)}, {
      handleRequest(_session, method, args) {
        if (method !== 'ping') throw new Error('unknown method: ' + method)
        return 'pong:' + String(args[0])
      },
    }),
  )
}
`

function makeTrustedExtension(): string {
  const dir = fs.realpathSync.native(mkTempDir('ue2-trusted-views-'))
  writeJson(path.join(dir, 'package.json'), {
    name: 'e2e-trusted-views',
    publisher: 'acme',
    version: '1.0.0',
    displayName: 'E2E Trusted Views',
    engines: { universe: '*' },
    type: 'module',
    main: './dist/extension.js',
    activationEvents: [`onView:${STATUS_VIEW}`, `onView:${DETAIL_VIEW}`],
    contributes: {
      commands: [{ command: OPEN_DETAIL_COMMAND, title: 'E2E: Open Trusted Detail' }],
      trustedViews: [
        {
          id: STATUS_VIEW,
          name: 'E2E Status',
          location: 'view',
          container: 'explorer',
          entry: './dist/renderer/status.js',
        },
        {
          id: DETAIL_VIEW,
          name: 'E2E Detail',
          location: 'editor',
          entry: './dist/renderer/detail.js',
        },
      ],
    },
    files: ['dist'],
  })
  writeModule(dir, 'dist/extension.js', trustedExtensionSource())
  writeModule(dir, 'dist/renderer/status.js', STATUS_COMPONENT)
  writeModule(dir, 'dist/renderer/detail.js', DETAIL_COMPONENT)
  return dir
}

function makeBrokenExtension(): string {
  const dir = fs.realpathSync.native(mkTempDir('ue2-trusted-views-broken-'))
  writeJson(path.join(dir, 'package.json'), {
    name: 'e2e-broken-view',
    publisher: 'acme',
    version: '1.0.0',
    displayName: 'E2E Broken Trusted View',
    engines: { universe: '*' },
    type: 'module',
    main: './dist/extension.js',
    activationEvents: [`onView:${BROKEN_VIEW}`],
    contributes: {
      trustedViews: [
        {
          id: BROKEN_VIEW,
          name: 'E2E Broken',
          location: 'view',
          container: 'explorer',
          entry: './dist/renderer/broken.js',
        },
      ],
    },
    files: ['dist'],
  })
  writeModule(dir, 'dist/extension.js', brokenExtensionSource())
  writeModule(dir, 'dist/renderer/broken.js', BROKEN_COMPONENT)
  return dir
}

const trustedExtDir = makeTrustedExtension()
const brokenExtDir = makeBrokenExtension()

export const test = createColdAppTest({
  appRoot: APP_ROOT,
  mainEntry: MAIN_ENTRY,
  extensions: [],
  extraArgs: [
    `--extension-development-path=${trustedExtDir}`,
    `--extension-development-path=${brokenExtDir}`,
  ],
})

// --- helpers -----------------------------------------------------------------

/** Renderer root of one contributed trusted view. */
function trustedView(page: Page, viewId: string): Locator {
  return page.locator(`[data-testid="trusted-view"][data-view-id="${viewId}"]`)
}

/** Bring the Explorer container to the front without toggling it closed. */
async function showExplorerContainer(workbench: WorkbenchPO): Promise<void> {
  await workbench.showExplorer()
  if ((await workbench.sideBar.activeContainerId()) !== 'workbench.view.explorer') {
    await workbench.activityBar.click('workbench.view.explorer')
  }
  await expect.poll(() => workbench.sideBar.activeContainerId()).toBe('workbench.view.explorer')
}

function detailTabId(key: string): string {
  return `trustedView:${TRUSTED_EXT_ID}:${DETAIL_VIEW}:${key}`
}

async function waitForCommand(page: Page, commandId: string): Promise<void> {
  // The extension host is Eventually: right after restore the contributed
  // command is not translated yet, and executeCommand on an unknown id is a
  // silent no-op. Wait for the ledger entry before firing it.
  await expect
    .poll(() => page.evaluate((id) => window.__E2E__!.hasCommand(id), commandId), {
      timeout: 20_000,
    })
    .toBe(true)
}

async function restartExtensionHost(page: Page): Promise<void> {
  const generationBefore = await page.evaluate(() => window.__E2E__!.getExtensionHostGeneration())
  await page.evaluate(
    () => void window.__E2E__!.runCommand('workbench.action.restartExtensionHost'),
  )
  await expect
    .poll(() => page.evaluate(() => window.__E2E__!.getExtensionHostGeneration()), {
      timeout: 30_000,
    })
    .toBeGreaterThan(generationBefore)
}

async function openDetail(
  workbench: WorkbenchPO,
  options: { key: string; title?: string; state?: unknown },
): Promise<unknown> {
  await waitForCommand(workbench.page, OPEN_DETAIL_COMMAND)
  return workbench.runCommand(OPEN_DETAIL_COMMAND, options)
}

// --- trusted development extension ------------------------------------------

test.describe('@p1 trusted views (development extension)', () => {
  test('sidebar view round-trips request/response and receives provider events', async ({
    workbench,
  }) => {
    await workbench.waitForRestored()
    await showExplorerContainer(workbench)

    const root = trustedView(workbench.page, STATUS_VIEW)
    await expect(root).toHaveCount(1, { timeout: 20_000 })
    await expect(root).toHaveAttribute('data-extension-id', TRUSTED_EXT_ID)

    await expect(root.getByTestId('e2e-status-reply')).toHaveText('pong:hello')
    // The provider posts `pong` while handling the request; the component's
    // onEvent listener must receive it through the host RPC.
    await expect(root.getByTestId('e2e-status-event')).toHaveText('pong=pong:hello')
  })

  test('context.trustedViews.openEditor renders state, dedupes by key and updates the tab title', async ({
    workbench,
  }) => {
    await workbench.waitForRestored()
    const page = workbench.page
    const detailTabs = page.locator(
      `[role="tab"][data-editor-id^="trustedView:${TRUSTED_EXT_ID}:${DETAIL_VIEW}:"]`,
    )
    const tab = page.locator(`[role="tab"][data-editor-id="${detailTabId('one')}"]`)

    await openDetail(workbench, {
      key: 'one',
      title: 'Initial Detail',
      state: { mode: 'alpha', count: 7 },
    })

    await expect(tab).toHaveCount(1, { timeout: 20_000 })
    const body = page.getByTestId('e2e-trusted-detail')
    await expect(body).toHaveCount(1)
    await expect(body).toHaveAttribute('data-location', 'editor')
    expect(JSON.parse((await body.getAttribute('data-state')) ?? 'null')).toEqual({
      mode: 'alpha',
      count: 7,
    })
    await expect(body.getByTestId('e2e-detail-reply')).toHaveText('pong:detail')
    // ctx.setTitle updates the tab label.
    await expect(tab).toContainText('Detail: alpha')

    // Same key → focus the existing tab instead of opening a second one.
    await openDetail(workbench, {
      key: 'one',
      title: 'Ignored Title',
      state: { mode: 'beta' },
    })
    await expect(detailTabs).toHaveCount(1)
    expect(JSON.parse((await body.getAttribute('data-state')) ?? 'null')).toEqual({
      mode: 'alpha',
      count: 7,
    })
    await expect(tab).toContainText('Detail: alpha')

    // A different key is a different tab.
    await openDetail(workbench, { key: 'two', title: 'Second Detail', state: { mode: 'beta' } })
    await expect(detailTabs).toHaveCount(2)
  })

  test('a crashing component degrades to an error placeholder without breaking the workbench', async ({
    workbench,
  }) => {
    await workbench.waitForRestored()
    await showExplorerContainer(workbench)

    const broken = trustedView(workbench.page, BROKEN_VIEW)
    await expect(broken).toHaveCount(1, { timeout: 20_000 })
    await expect(broken.getByTestId('trusted-view-error')).toContainText(
      'trusted view fixture exploded at import',
    )

    // The sibling trusted view still works.
    const healthy = trustedView(workbench.page, STATUS_VIEW)
    await expect(healthy.getByTestId('e2e-status-reply')).toHaveText('pong:hello')

    // The editor area is unaffected: a normal editor opens.
    await workbench.runCommand('workbench.action.files.newUntitledFile')
    await expect.poll(() => workbench.getActiveEditorUri()).toContain('untitled')
  })

  test('restarting the extension host remounts the component with a fresh session', async ({
    workbench,
  }) => {
    await workbench.waitForRestored()
    const page = workbench.page
    const tab = page.locator(`[role="tab"][data-editor-id="${detailTabId('restart')}"]`)
    const body = page.getByTestId('e2e-trusted-detail')

    await openDetail(workbench, {
      key: 'restart',
      title: 'Restart Detail',
      state: { mode: 'restart', count: 1 },
    })
    await expect(tab).toHaveCount(1, { timeout: 20_000 })
    await expect(body.getByTestId('e2e-detail-reply')).toHaveText('pong:detail')
    const sessionBefore = await body.getAttribute('data-session-id')
    expect(sessionBefore).toBeTruthy()

    await page.evaluate(
      () => void window.__E2E__!.runCommand('workbench.action.restartExtensionHost'),
    )

    // The host teardown invalidates sessions; the component remounts and
    // re-resolves against the new host (a new session id proves the remount).
    await expect
      .poll(
        async () => {
          if ((await body.count()) === 0) return sessionBefore
          return (await body.getAttribute('data-session-id')) ?? sessionBefore
        },
        { timeout: 30_000 },
      )
      .not.toBe(sessionBefore)
    await expect(body.getByTestId('e2e-detail-reply')).toHaveText('pong:detail')
    expect(JSON.parse((await body.getAttribute('data-state')) ?? 'null')).toEqual({
      mode: 'restart',
      count: 1,
    })
  })
})

// --- untrusted user extension ------------------------------------------------

test.describe('@p1 trusted views (untrusted user extension)', () => {
  test('does not load until "Trust and Load" persists the User setting', async ({
    workbench,
    scratchDir,
  }) => {
    await workbench.waitForRestored()
    const page = workbench.page
    await page.evaluate(() => window.__E2E__!.whenUserSettingsInitialized())
    await showExplorerContainer(workbench)

    const extensionRoot = makeUntrustedExtensionIn(scratchDir('ue2-untrusted-src-'))
    const vsixPath = path.join(path.dirname(extensionRoot), 'untrusted-tools.vsix')
    await createVsix(extensionRoot, vsixPath)

    const installedId = await page.evaluate(
      (file) => window.__E2E__!.installVsixExtension(file),
      vsixPath,
    )
    expect(installedId).toBe(UNTRUSTED_EXT_ID)
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getInstalledExtensionIds()), {
        timeout: 20_000,
      })
      .toContain(UNTRUSTED_EXT_ID)

    // Untrusted: the view never registers, and the extension is prompted once.
    const root = trustedView(page, UNTRUSTED_VIEW)
    await expect(root).toHaveCount(0)
    const toast = page
      .getByTestId('notification-toast-item')
      .filter({ hasText: 'provides trusted views' })
      .filter({ hasText: UNTRUSTED_DISPLAY_NAME })
    await expect(toast).toHaveCount(1, { timeout: 20_000 })

    // A host restart re-translates every contribution; the per-session dedupe
    // must keep the prompt at one. Wait for the new host so the startup-activated
    // extension has announced its provider (which must survive until trust).
    await restartExtensionHost(page)
    await expect(toast).toHaveCount(1, { timeout: 20_000 })
    await expect(root).toHaveCount(0)

    await toast.getByRole('button', { name: 'Trust and Load' }).click()

    await expect
      .poll(() =>
        page.evaluate((key) => window.__E2E__!.getConfigurationValueOrigin(key), TRUST_SETTING),
      )
      .toBe('user')
    const trustedIds = await page.evaluate(
      (key) => window.__E2E__!.getConfigurationValue(key),
      TRUST_SETTING,
    )
    expect(Array.isArray(trustedIds) ? trustedIds : []).toContain(UNTRUSTED_EXT_ID)

    // Re-applied without a reload: the view now mounts and talks to its provider.
    await showExplorerContainer(workbench)
    await expect(root).toHaveCount(1, { timeout: 20_000 })
    await expect(root.getByTestId('e2e-untrusted-reply')).toHaveText('pong:untrusted')
  })
})

function makeUntrustedExtensionIn(parent: string): string {
  const dir = path.join(parent, 'extension')
  fs.mkdirSync(path.join(dir, 'dist', 'renderer'), { recursive: true })
  writeJson(path.join(dir, 'package.json'), {
    name: UNTRUSTED_EXT_NAME,
    publisher: 'acme',
    version: '1.0.0',
    displayName: UNTRUSTED_DISPLAY_NAME,
    engines: { universe: '*' },
    type: 'module',
    main: './dist/extension.js',
    // Startup activation is deliberate: it announces the provider before the
    // user trusts the extension, so the deferred-provider replay is covered too.
    activationEvents: ['onStartupFinished', `onView:${UNTRUSTED_VIEW}`],
    capabilities: { untrustedWorkspaces: true },
    contributes: {
      trustedViews: [
        {
          id: UNTRUSTED_VIEW,
          name: 'Untrusted Status',
          location: 'view',
          container: 'explorer',
          entry: './dist/renderer/untrusted.js',
        },
      ],
    },
    files: ['dist'],
  })
  writeModule(dir, 'dist/extension.js', UNTRUSTED_EXTENSION_SOURCE)
  writeModule(dir, 'dist/renderer/untrusted.js', UNTRUSTED_COMPONENT)
  return dir
}

// --- cold restart restore ----------------------------------------------------

function devArgs(workspaceDir: string): string[] {
  return [`--extension-development-path=${trustedExtDir}`, workspaceDir.replace(/\\/g, '/')]
}

async function launchRestorePair(userDataDir: string, workspaceDir: string) {
  seedBaselineUserData(userDataDir)
  const app = await launchApp({
    appRoot: APP_ROOT,
    mainEntry: MAIN_ENTRY,
    userDataDir,
    extensions: [],
    extraArgs: devArgs(workspaceDir),
  })
  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await waitForProbe(page)
    await evaluateWhenRestored(page)
    return { app, page, workbench: new WorkbenchPO(page) }
  } catch (err) {
    await closeApp(app)
    throw err
  }
}

test.describe('@p1 trusted views (cold restart)', () => {
  test('restores a trusted-view editor tab and re-establishes its session', async () => {
    test.setTimeout(180_000)
    const userDataDir = mkTempDir('ue2-tv-restore-ud-')
    const workspaceDir = mkTempDir('ue2-tv-restore-ws-')
    fs.writeFileSync(path.join(workspaceDir, 'readme.txt'), 'trusted view restore\n', 'utf8')
    try {
      const first = await launchRestorePair(userDataDir, workspaceDir)
      try {
        const tab = first.page.locator(
          `[role="tab"][data-editor-id="${detailTabId('restore-key')}"]`,
        )
        const body = first.page.getByTestId('e2e-trusted-detail')
        await openDetail(first.workbench, {
          key: 'restore-key',
          title: 'Restore Detail',
          state: { mode: 'restore', count: 42 },
        })
        await expect(tab).toHaveCount(1, { timeout: 20_000 })
        await expect(body.getByTestId('e2e-detail-reply')).toHaveText('pong:detail')
        await expect(tab).toContainText('Detail: restore')
        await expectNoLeaks(first.page)
      } finally {
        await closeApp(first.app)
      }

      // Same userData + same workspace folder: the tab is deserialized from
      // workspace state and the component re-resolves against a fresh host.
      const second = await launchRestorePair(userDataDir, workspaceDir)
      try {
        const tab = second.page.locator(
          `[role="tab"][data-editor-id="${detailTabId('restore-key')}"]`,
        )
        const body = second.page.getByTestId('e2e-trusted-detail')
        await expect(tab).toHaveCount(1, { timeout: 30_000 })
        await expect(tab).toContainText('Detail: restore')
        await expect(body.getByTestId('e2e-detail-reply')).toHaveText('pong:detail', {
          timeout: 30_000,
        })
        expect(JSON.parse((await body.getAttribute('data-state')) ?? 'null')).toEqual({
          mode: 'restore',
          count: 42,
        })
        await expectNoLeaks(second.page)
      } finally {
        await closeApp(second.app)
      }
    } finally {
      for (const dir of [workspaceDir, userDataDir]) {
        try {
          fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
        } catch {
          // Best-effort: Windows may still be releasing handles.
        }
      }
    }
  })
})
