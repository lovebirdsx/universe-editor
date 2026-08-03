/*---------------------------------------------------------------------------------------------
 *  ACP session-create handshake observability (@perf + opt-in real codex).
 *
 *  Case 1 (echo agent, @perf): drives newSession against the echo fixture and
 *  asserts the create-profile step sequence is complete and monotonic — a
 *  regression guard for the instrumentation itself. Observe-only for timings
 *  (shared CI runners are too noisy for hard budgets); the profile is attached
 *  as an artifact.
 *
 *  Case 2 (real codex, manual): enabled only with UNIVERSE_E2E_REAL_CODEX=1 and
 *  UNIVERSE_E2E_CODEX_PATH=<codex.exe>. Seeds a GIT workspace (the native
 *  `git rev-parse` stall in thread/start only reproduces in a git repo),
 *  points `acp.codex.source=custom` at the given binary, and records the
 *  profile to test-results/acp-session-create-perf.json. Use it to compare
 *  codex binary versions (see memory codex-session-skills-scan-slow):
 *
 *    pnpm --filter @universe-editor/editor build
 *    cross-env UNIVERSE_E2E_REAL_CODEX=1 UNIVERSE_E2E_CODEX_PATH=C:\\path\\to\\codex.exe \
 *      pnpm --filter @universe-editor/editor e2eg "real codex"
 *--------------------------------------------------------------------------------------------*/

import { execSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, expect } from '../fixtures/sharedApp.js'
import { test as coldTest, expect as coldExpect } from '../fixtures/electronApp.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ECHO_AGENT_PATH = resolve(__dirname, '..', '..', 'src', 'test-fixtures', 'echoAgent.cjs')
const RESULTS_DIR = join(__dirname, '..', 'test-results')

test.describe('@perf acp session create perf', () => {
  test('records the echo-agent create profile', async ({ page }, testInfo) => {
    await page.evaluate(([id, p]) => window.__E2E__!.installAcpEchoAgent(id, p), [
      'echo',
      ECHO_AGENT_PATH,
    ] as const)

    await page.evaluate(() => {
      void window.__E2E__!.runCommand('workbench.action.agent.newSession')
    })
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getAcpSessionStatus()), {
        timeout: 15000,
      })
      .toBe('idle')

    const profiles = await page.evaluate(() => window.__E2E__!.getAcpSessionCreateProfiles())
    expect(profiles.length).toBeGreaterThan(0)
    const profile = profiles[profiles.length - 1]!
    expect(profile.agentId).toBe('echo')
    expect(profile.failed).toBeUndefined()
    expect(profile.endedAt).toBeDefined()
    expect(profile.pooledConnection).toBe(false)
    // Full service+client layer sequence for a fresh spawn. The client-layer
    // steps (binary/spawn/initialize) nest inside the service's connect segment.
    expect(profile.steps.map((s) => s.name)).toEqual([
      'willResolveMcp',
      'didResolveMcp',
      'willConnect',
      'willResolveBinary',
      'didResolveBinary',
      'willSpawn',
      'didSpawn',
      'willInitialize',
      'didInitialize',
      'didConnect',
      'willNewSession',
      'didNewSession',
      'didHistoryAdd',
      'didAttach',
    ])
    const ats = profile.steps.map((s) => s.at)
    expect([...ats].sort((a, b) => a - b)).toEqual(ats)

    // A second session for the same (agentId, cwd) reuses the pooled process:
    // the binary/spawn/initialize segments must collapse to a pool hit.
    await page.evaluate(() => {
      void window.__E2E__!.runCommand('workbench.action.agent.newSession')
    })
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getAcpSessionCount()), { timeout: 15000 })
      .toBe(2)
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getAcpSessionStatus()), {
        timeout: 15000,
      })
      .toBe('idle')
    const profiles2 = await page.evaluate(() => window.__E2E__!.getAcpSessionCreateProfiles())
    const pooled = profiles2[profiles2.length - 1]!
    expect(pooled.pooledConnection).toBe(true)
    expect(pooled.steps.map((s) => s.name)).toEqual([
      'willResolveMcp',
      'didResolveMcp',
      'willConnect',
      'willInitialize',
      'didInitialize',
      'didConnect',
      'willNewSession',
      'didNewSession',
      'didHistoryAdd',
      'didAttach',
    ])

    await testInfo.attach('session-create-profiles', {
      body: JSON.stringify(profiles2, null, 2),
      contentType: 'application/json',
    })
    const summarize = (p: (typeof profiles2)[number]) =>
      `agent=${p.agentId} pooled=${p.pooledConnection} total=${
        (p.endedAt ?? 0) - p.startedAt
      }ms steps=${p.steps.length}`
    console.log(`[perf] session create profiles:\n${profiles2.map(summarize).join('\n')}`)
  })
})

// ---------------------------------------------------------------------------
// Real codex (opt-in) — cold-launch fixture so the git-repo workspace can be
// seeded per test. Never runs in CI.
// ---------------------------------------------------------------------------

const REAL_CODEX = process.env.UNIVERSE_E2E_REAL_CODEX === '1'
const CODEX_PATH = process.env.UNIVERSE_E2E_CODEX_PATH ?? ''

coldTest.describe('acp session create perf — real codex (manual)', () => {
  coldTest.skip(
    !REAL_CODEX || !CODEX_PATH,
    'set UNIVERSE_E2E_REAL_CODEX=1 and UNIVERSE_E2E_CODEX_PATH',
  )

  coldTest.use({
    workspaceSeeder: {
      seed(dir) {
        // The native thread/start git-probe stall only reproduces inside a git
        // repository — init one (contents don't matter).
        execSync('git init', { cwd: dir, stdio: 'ignore' })
        writeFileSync(join(dir, 'README.md'), '# perf probe\n')
      },
    },
  })

  coldTest('records the real codex create profile', async ({ page, workbench }, testInfo) => {
    coldTest.slow()
    await workbench.waitForRestored()

    await page.evaluate(
      ([exePath]) => {
        window.__E2E__!.updateConfigValue('acp.codex.source', 'custom')
        window.__E2E__!.updateConfigValue('acp.codex.executablePath', exePath)
        window.__E2E__!.updateConfigValue('acp.defaultAgentId', 'codex')
      },
      [CODEX_PATH] as const,
    )

    await page.evaluate(() => {
      void window.__E2E__!.runCommand('workbench.action.agent.newSession')
    })
    // The handshake may exceed 10s on Windows (native git-probe stall inside
    // thread/start) — and may outright fail when codex has no credentials.
    // Either way the profile is recorded; wait for it instead of the status.
    await coldExpect
      .poll(
        async () => {
          const profiles = await page.evaluate(() => window.__E2E__!.getAcpSessionCreateProfiles())
          return profiles.length
        },
        { timeout: 120_000 },
      )
      .toBeGreaterThan(0)

    const profiles = await page.evaluate(() => window.__E2E__!.getAcpSessionCreateProfiles())
    const profile = profiles[profiles.length - 1]!
    expect(profile.agentId).toBe('codex')
    // Sanity: the attempt reached at least the session/new step (or failed trying).
    expect(profile.steps.map((s) => s.name)).toContain('willConnect')

    mkdirSync(RESULTS_DIR, { recursive: true })
    const artifact = join(RESULTS_DIR, 'acp-session-create-perf.json')
    writeFileSync(artifact, `${JSON.stringify(profile, null, 2)}\n`, 'utf8')
    await testInfo.attach('real-codex-session-create-profile', {
      body: JSON.stringify(profile, null, 2),
      contentType: 'application/json',
    })
    const segments = profile.steps
      .map((s, i) => {
        const prev = i === 0 ? profile.startedAt : profile.steps[i - 1]!.at
        return `  +${String(s.at - prev).padStart(6)}ms  ${s.name}`
      })
      .join('\n')
    console.log(`[perf] real codex create profile (failed=${profile.failed ?? 'no'}):\n${segments}`)
  })
})
