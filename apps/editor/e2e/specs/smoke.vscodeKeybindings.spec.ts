/*---------------------------------------------------------------------------------------------
 *  VSCode-compat keybinding resolution smoke test (@p1).
 *
 *  End-to-end guard for the full chain: a binding in VSCode's keybindings.json
 *  pointing at a **lazily-registered monaco command** must end up in
 *  KeybindingsRegistry once the workbench has settled.
 *
 *  根因（详见 MonacoKeybindingSyncContribution / UserKeybindingsService）：
 *  monaco 命令（如 editor.action.copyLinesDownAction）只在 monaco 加载、
 *  bridgeAllMonacoActions() 把它们镜像进 CommandsRegistry 后才存在；而只读的
 *  VSCode keybindings 层在启动期就读完，并有命令存在性过滤——启动期这条绑定被跳过。
 *  必须有「桥接完成后再 reload 一次」才能把它补回来。修复点是 MonacoKeybindingSync-
 *  Contribution，确定性复现+判别在 UserKeybindingsService 的单测里。
 *
 *  本 spec 是**端到端守护**而非修复判别器：受 ThemeContribution 启动期急切加载
 *  monaco + ExtensionsContribution 一次性 reload 的时序影响，e2e 里 monaco 桥接通常
 *  抢先于 ext-reload，二者都能把绑定补上，故 spec 无法单独隔离某一条修复路径。它守护
 *  的是「整条链跑通」：用户真实配置（含 when 子句）下，该绑定最终确实进了 registry。
 *
 *  用 UNIVERSE_VSCODE_KEYBINDINGS_PATH 把只读 VSCode keybindings 层指到 tmp 文件，
 *  避免污染宿主机真实 VSCode 配置。
 *--------------------------------------------------------------------------------------------*/

import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { APP_ROOT, MAIN_ENTRY } from '../fixtures/electronApp.js'

const KEY = 'ctrl+shift+d'
const COMMAND = 'editor.action.copyLinesDownAction'
// The user's exact binding, when clause included. getKeybindingCommandsForKey
// ignores `when`, so registration is asserted regardless of context focus.
const WHEN = 'editorTextFocus && !editorReadonly'

test.describe('@p1 vscode keybindings', () => {
  test('binds a VSCode keybinding to a lazily-registered monaco command', async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), 'universe-editor-e2e-vscodekb-'))
    writeFileSync(
      join(userDataDir, 'settings.json'),
      JSON.stringify({ 'workbench.language': 'en-US', 'update.mode': 'manual' }, null, 2),
      'utf8',
    )
    writeFileSync(
      join(userDataDir, 'state.json'),
      JSON.stringify({ 'welcome.agentOnboarding.seen': true }, null, 2),
      'utf8',
    )
    const vscodeKeybindingsPath = join(userDataDir, 'vscode-keybindings.json')
    writeFileSync(
      vscodeKeybindingsPath,
      JSON.stringify([{ key: KEY, command: COMMAND, when: WHEN }], null, 2),
      'utf8',
    )
    const filePath = join(userDataDir, 'sample.txt')
    writeFileSync(filePath, 'line one\nline two\n', 'utf8')

    const { ELECTRON_RUN_AS_NODE: _ignored, ...inheritedEnv } = process.env
    const app = await electron.launch({
      args: [MAIN_ENTRY, `--user-data-dir=${userDataDir}`],
      cwd: APP_ROOT,
      env: {
        ...inheritedEnv,
        UNIVERSE_E2E: '1',
        UNIVERSE_VSCODE_KEYBINDINGS_PATH: vscodeKeybindingsPath,
        NODE_ENV: inheritedEnv['NODE_ENV'] ?? 'production',
      },
    })
    try {
      const page = await app.firstWindow()
      await page.waitForLoadState('domcontentloaded')
      await page.waitForFunction(() =>
        Boolean((window as unknown as Record<string, unknown>)['__E2E__']),
      )
      await page.evaluate(() => window.__E2E__!.whenRestored())

      // Wait for the extension host to boot and translate its contributions
      // (git.commit present) — its one-shot keybinding reload has then run.
      await expect
        .poll(() => page.evaluate(() => window.__E2E__!.hasCommand('git.commit')), {
          timeout: 30_000,
          message: 'extension host should boot and contribute git.commit',
        })
        .toBe(true)

      // Open a file → ensures monaco is loaded and its actions are bridged into
      // CommandsRegistry (the lazy command the VSCode binding points at).
      await page.evaluate((p) => window.__E2E__!.openFileUri(p), filePath)
      await expect
        .poll(() => page.evaluate((c) => window.__E2E__!.hasCommand(c), COMMAND), {
          timeout: 15_000,
          message: `${COMMAND} should be bridged once monaco loads`,
        })
        .toBe(true)

      // The full-chain guard: the VSCode binding to that monaco command must have
      // landed in KeybindingsRegistry (ignoring its when clause).
      await expect
        .poll(() => page.evaluate((k) => window.__E2E__!.getKeybindingCommandsForKey(k), KEY), {
          timeout: 15_000,
          message: `${KEY} should be bound to ${COMMAND} after the monaco action bridge`,
        })
        .toContain(COMMAND)
    } finally {
      await app.close()
    }
  })

  // Real-world regression: a user's keybindings.json often has *several* entries
  // for the same command (their custom key plus the kept default). Each must
  // survive — an earlier design keyed registrations by command id, so a later
  // entry clobbered the earlier one and the custom key silently stopped working.
  test('keeps every key when one monaco command has multiple VSCode entries', async () => {
    // Canonical modifier order (alphabetical) — KeybindingsRegistry stores keys
    // normalized this way, and the probe compares the stored form verbatim.
    const SECOND_KEY = 'alt+shift+down'
    const userDataDir = mkdtempSync(join(tmpdir(), 'universe-editor-e2e-vscodekb-multi-'))
    writeFileSync(
      join(userDataDir, 'settings.json'),
      JSON.stringify({ 'workbench.language': 'en-US', 'update.mode': 'manual' }, null, 2),
      'utf8',
    )
    writeFileSync(
      join(userDataDir, 'state.json'),
      JSON.stringify({ 'welcome.agentOnboarding.seen': true }, null, 2),
      'utf8',
    )
    const vscodeKeybindingsPath = join(userDataDir, 'vscode-keybindings.json')
    writeFileSync(
      vscodeKeybindingsPath,
      JSON.stringify(
        [
          { key: KEY, command: COMMAND, when: WHEN },
          { key: SECOND_KEY, command: COMMAND, when: WHEN },
        ],
        null,
        2,
      ),
      'utf8',
    )
    const filePath = join(userDataDir, 'sample.txt')
    writeFileSync(filePath, 'line one\nline two\n', 'utf8')

    const { ELECTRON_RUN_AS_NODE: _ignored, ...inheritedEnv } = process.env
    const app = await electron.launch({
      args: [MAIN_ENTRY, `--user-data-dir=${userDataDir}`],
      cwd: APP_ROOT,
      env: {
        ...inheritedEnv,
        UNIVERSE_E2E: '1',
        UNIVERSE_VSCODE_KEYBINDINGS_PATH: vscodeKeybindingsPath,
        NODE_ENV: inheritedEnv['NODE_ENV'] ?? 'production',
      },
    })
    try {
      const page = await app.firstWindow()
      await page.waitForLoadState('domcontentloaded')
      await page.waitForFunction(() =>
        Boolean((window as unknown as Record<string, unknown>)['__E2E__']),
      )
      await page.evaluate(() => window.__E2E__!.whenRestored())

      await expect
        .poll(() => page.evaluate(() => window.__E2E__!.hasCommand('git.commit')), {
          timeout: 30_000,
          message: 'extension host should boot and contribute git.commit',
        })
        .toBe(true)

      await page.evaluate((p) => window.__E2E__!.openFileUri(p), filePath)
      await expect
        .poll(() => page.evaluate((c) => window.__E2E__!.hasCommand(c), COMMAND), {
          timeout: 15_000,
          message: `${COMMAND} should be bridged once monaco loads`,
        })
        .toBe(true)

      // Both keys must resolve to the command — neither clobbers the other.
      await expect
        .poll(() => page.evaluate((k) => window.__E2E__!.getKeybindingCommandsForKey(k), KEY), {
          timeout: 15_000,
          message: `${KEY} should remain bound to ${COMMAND}`,
        })
        .toContain(COMMAND)
      await expect
        .poll(
          () => page.evaluate((k) => window.__E2E__!.getKeybindingCommandsForKey(k), SECOND_KEY),
          {
            timeout: 15_000,
            message: `${SECOND_KEY} should also be bound to ${COMMAND}`,
          },
        )
        .toContain(COMMAND)
    } finally {
      await app.close()
    }
  })
})
