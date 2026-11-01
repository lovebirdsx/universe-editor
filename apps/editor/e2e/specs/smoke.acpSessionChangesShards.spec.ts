/*---------------------------------------------------------------------------------------------
 * ACP session-change shards — migration, per-session writes and restart (@p1).
 *
 *  Seeds the legacy single-blob `acp.sessionChanges` (several sessions, each with a
 *  large baseline) before launch, then proves:
 *    - main imports it into per-session shard files and removes only the legacy key;
 *    - an edit to one session rewrites only that session's shard — the other
 *      sessions' files are byte-identical, so the whole history never crosses IPC;
 *    - the outbound encode for that write stays far below the 4MiB large-frame line
 *      and is attributed to the sessionChangesStore.write channel;
 *    - rewind preview still reads the persisted batches;
 *    - a restart loads the same shards with the edit still present and without
 *      re-running the legacy import.
 *--------------------------------------------------------------------------------------------*/

import { test, expect } from '@playwright/test'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  ENABLED_EXTENSIONS_ENV,
  INITIAL_SETTINGS,
  INITIAL_STATE,
  launchElectron,
  mkTempDir,
} from '@universe-editor/e2e-harness'
import { APP_ROOT, MAIN_ENTRY, closeApp } from '../fixtures/electronApp.js'

const LARGE_BASELINE = 'x'.repeat(800_000)
const SESSION_COUNT = 8
const FOUR_MIB = 4 * 1024 * 1024

const shardName = (sessionId: string): string =>
  `${createHash('sha256').update(sessionId).digest('hex').slice(0, 32)}.json`

interface SeededSession {
  readonly sessionId: string
  readonly files: readonly unknown[]
}

function legacySessions(rewindPath: string): SeededSession[] {
  const sessions: SeededSession[] = []
  for (let i = 0; i < SESSION_COUNT - 1; i++) {
    sessions.push({
      sessionId: `legacy-${i}`,
      files: [
        {
          path: `/work/legacy-${i}.ts`,
          batches: [],
          batchCount: 0,
          origin: 'agent',
          baseline: LARGE_BASELINE,
          baselineSource: 'reported',
        },
      ],
    })
  }
  sessions.push({
    sessionId: 'rewind-1',
    files: [
      {
        path: rewindPath,
        batches: [
          {
            toolCallId: 'tc-1',
            hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-A', '+a'] }],
          },
          {
            toolCallId: 'tc-2',
            hunks: [
              {
                oldStart: 2,
                oldLines: 1,
                newStart: 2,
                newLines: 1,
                lines: ['-ONE', '+TWO'],
              },
            ],
          },
        ],
        batchCount: 2,
        origin: 'agent',
        baseline: 'a\nONE\nc',
        baselineSource: 'reported',
      },
    ],
  })
  return sessions
}

async function launch(userDataDir: string) {
  const { ELECTRON_RUN_AS_NODE: _ignored, ...inheritedEnv } = process.env
  const app = await launchElectron({
    args: [MAIN_ENTRY, `--user-data-dir=${userDataDir}`],
    cwd: APP_ROOT,
    env: {
      ...inheritedEnv,
      UNIVERSE_E2E: '1',
      NODE_ENV: inheritedEnv['NODE_ENV'] ?? 'production',
      [ENABLED_EXTENSIONS_ENV]: '',
    },
  })
  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.waitForFunction(() =>
      Boolean((window as unknown as Record<string, unknown>)['__E2E__']),
    )
    await page.evaluate(() => window.__E2E__!.whenRestored())
    return { app, page }
  } catch (err) {
    await closeApp(app)
    throw err
  }
}

const SHARD_FILE = /^[0-9a-f]{32}\.json$/

function shardFiles(userDataDir: string): string[] {
  const dir = join(userDataDir, 'session-changes', 'global', 'sessions')
  return readdirSync(dir).filter((name) => SHARD_FILE.test(name))
}

function shardTexts(userDataDir: string): Map<string, string> {
  const dir = join(userDataDir, 'session-changes', 'global', 'sessions')
  const out = new Map<string, string>()
  for (const name of shardFiles(userDataDir)) {
    out.set(name, readFileSync(join(dir, name), 'utf8'))
  }
  return out
}

function readState(userDataDir: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(userDataDir, 'state.json'), 'utf8')) as Record<
    string,
    unknown
  >
}

test.describe('@p1 acp session change shards', () => {
  test('migrates legacy history into per-session shards and restores it', async () => {
    test.setTimeout(180_000)
    test.slow()
    const userDataDir = mkTempDir('universe-editor-session-shards-')
    const rewindPath = join(userDataDir, 'rewind.ts')
    writeFileSync(rewindPath, ['a', 'TWO', 'c'].join('\n'), 'utf8')

    const legacy = {
      schemaVersion: 3,
      sessions: legacySessions(rewindPath),
    }
    const seeded = {
      ...(JSON.parse(INITIAL_STATE) as Record<string, unknown>),
      'acp.sessionChanges': legacy,
    }
    writeFileSync(join(userDataDir, 'settings.json'), INITIAL_SETTINGS, 'utf8')
    writeFileSync(join(userDataDir, 'state.json'), JSON.stringify(seeded, null, 2), 'utf8')

    let first = await launch(userDataDir)
    try {
      // Tracker hydration (and thus the shard load) completes after Restored.
      await expect
        .poll(
          () =>
            first.page.evaluate(() => window.__E2E__!.sessionChangesRead('legacy-0').files.length),
          { timeout: 30_000 },
        )
        .toBe(1)

      for (let i = 0; i < SESSION_COUNT - 1; i++) {
        const snapshot = await first.page.evaluate(
          (id) => window.__E2E__!.sessionChangesRead(id),
          `legacy-${i}`,
        )
        expect(snapshot.files).toHaveLength(1)
        expect(snapshot.files[0]?.hasBaseline).toBe(true)
        expect(snapshot.bytes).toBeGreaterThan(700_000)
      }
      const rewind = await first.page.evaluate(() => window.__E2E__!.sessionChangesRead('rewind-1'))
      expect(rewind.files[0]?.batchCount).toBe(2)

      // Main removed only the legacy key; the other seeded keys survived and one
      // shard file exists per session (no whole-history blob left behind).
      await expect
        .poll(() => 'acp.sessionChanges' in readState(userDataDir), { timeout: 20_000 })
        .toBe(false)
      expect(readState(userDataDir)['welcome.agentOnboarding.seen']).toBe(true)
      expect(shardFiles(userDataDir)).toHaveLength(SESSION_COUNT)

      // Preview rewind from the persisted batches (reads disk, writes nothing).
      const impact = await first.page.evaluate(() =>
        window.__E2E__!.sessionChangesPreviewRestore('rewind-1', ['tc-2']),
      )
      expect(impact.filesChanged).toHaveLength(1)
      expect(impact.insertions).toBe(1)
      expect(impact.deletions).toBe(1)

      const before = shardTexts(userDataDir)
      await first.page.evaluate(() => window.__E2E__!.resetIpcEncodeStats())
      await first.page.evaluate(
        (baseline) =>
          window.__E2E__!.sessionChangesRecord(
            'legacy-0',
            '/work/legacy-0.ts',
            'tc-small',
            [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+b'] }],
            { baseline },
          ),
        LARGE_BASELINE,
      )
      await first.page.evaluate(() => window.__E2E__!.sessionChangesFlush())

      const stats = await first.page.evaluate(() => window.__E2E__!.getIpcEncodeStats())
      expect(stats.largeCount).toBe(0)
      expect(stats.largestBytes).toBeLessThan(FOUR_MIB)
      expect(
        stats.recent.some((o) => o.channel === 'sessionChangesStore' && o.name === 'write'),
      ).toBe(true)

      // Only the edited session's shard changed; the other seven are byte-identical.
      const after = shardTexts(userDataDir)
      expect(after.size).toBe(before.size)
      const changed = [...after.keys()].filter((name) => after.get(name) !== before.get(name))
      expect(changed).toEqual([shardName('legacy-0')])
      const edited = await first.page.evaluate(() => window.__E2E__!.sessionChangesRead('legacy-0'))
      expect(edited.files[0]?.batchCount).toBe(1)
      expect(edited.files[0]?.hasBaseline).toBe(true)
    } finally {
      await closeApp(first.app)
    }

    // Restart against the same userData: the shards (not the legacy key) are the
    // source, and the small edit is still there.
    first = await launch(userDataDir)
    try {
      await expect
        .poll(() => 'acp.sessionChanges' in readState(userDataDir), { timeout: 20_000 })
        .toBe(false)
      await expect
        .poll(
          () =>
            first.page.evaluate(
              () => window.__E2E__!.sessionChangesRead('legacy-0').files[0]?.batchCount,
            ),
          { timeout: 30_000 },
        )
        .toBe(1)
      const restored = await first.page.evaluate(() =>
        window.__E2E__!.sessionChangesRead('legacy-0'),
      )
      expect(restored.files).toHaveLength(1)
      expect(restored.files[0]?.path).toBe('/work/legacy-0.ts')
      const rewindAgain = await first.page.evaluate(() =>
        window.__E2E__!.sessionChangesRead('rewind-1'),
      )
      expect(rewindAgain.files[0]?.batchCount).toBe(2)
      expect(shardFiles(userDataDir)).toHaveLength(SESSION_COUNT)
    } finally {
      await closeApp(first.app)
    }
  })
})
