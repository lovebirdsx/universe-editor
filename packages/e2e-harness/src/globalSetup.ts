/*---------------------------------------------------------------------------------------------
 *  Automatic Xvfb bootstrap for headless Linux e2e runs.
 *
 *  Electron needs an X display even for offscreen rendering. CI wraps the runner
 *  in `xvfb-run` (see .github/workflows/ci.yml), but a dev running `pnpm e2e`
 *  bare on Linux/WSL has no DISPLAY and every worker would fail at
 *  electron.launch — previously forcing the manual `xvfb-run` wrapping. Playwright's
 *  globalSetup runs in the RUNNER process before workers fork, and process.env
 *  changes made here are inherited by the worker children (Electron is spawned by
 *  a worker), so setting DISPLAY once here covers the whole run.
 *
 *  WSL defaults to offscreen too: WSLg sets DISPLAY=:0 even though running e2e
 *  inside WSL is documented as zero-distraction, so a bare `pnpm e2e` would
 *  otherwise pop real windows onto the Windows desktop. UNIVERSE_E2E_SHOW=1 (or the
 *  e2e:headed / e2e:ui scripts, which set it) opts back into the real window;
 *  headless Linux (no DISPLAY) behaves exactly as before.
 *
 *  When active it walks a fixed range of display numbers (:99 through :119) and
 *  starts `Xvfb :<N>` on the first one whose socket accepts connections. Explicit
 *  numbers (rather than `-displayfd`) matter on WSLg: /tmp/.X11-unix is a
 *  read-only mount there, so Xvfb cannot create its unix socket file, and
 *  `-displayfd` mode treats that bind failure as fatal; an explicit `:<N>`
 *  downgrades it to a warning and the server keeps serving over the Linux
 *  abstract socket (@/tmp/.X11-unix/X<N>) — the same route
 *  `xvfb-run --auto-servernum` relies on. Fail-fast is deliberate on headless
 *  Linux: a missing/failing Xvfb is a machine-setup defect that would otherwise
 *  surface as a per-test retry storm, so we throw once with the fix spelled out.
 *  On WSL a real DISPLAY already exists, so the same failures degrade to a warning
 *  and fall back to that display instead.
 *--------------------------------------------------------------------------------------------*/

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import net from 'node:net'

// Screen geometry matches CI's `xvfb-run --server-args="-screen 0 1280x1024x24"`.
const XVFB_SCREEN = '1280x1024x24'
const XVFB_START_TIMEOUT_MS = 10_000
const PROBE_INTERVAL_MS = 100
// Rolling stderr buffer bound: drop the head, keep the tail.
const STDERR_TAIL_MAX = 8 * 1024
// Fixed candidate window, like `xvfb-run --auto-servernum` scans, instead of
// letting Xvfb pick a number via `-displayfd`.
const DISPLAY_START = 99
const DISPLAY_END = 119

const XVFB_FIX_HINT =
  '修复：`bash scripts/wsl/bootstrap.sh` 或 `sudo apt-get install -y xvfb`；详见 `docs/development/wsl-e2e.md`'

// WSLg exports DISPLAY=:0, so "has a display" is not the same as "wants a real
// window". Detect WSL from /proc/version (the same gate scripts/wsl/bootstrap.sh
// uses); a read failure is treated as non-WSL, keeping the original headless-only
// rule for plain Linux containers/servers.
function isWsl(): boolean {
  try {
    return /microsoft/i.test(readFileSync('/proc/version', 'utf8'))
  } catch {
    return false
  }
}

function probeSocket(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect(path)
    socket.once('connect', () => {
      socket.destroy()
      resolve(true)
    })
    socket.once('error', () => {
      socket.destroy()
      resolve(false)
    })
  })
}

// Xvfb listens on a socket file under /tmp/.X11-unix on normal Linux, but WSLg
// serves it only as an abstract socket (a leading `\0` selects the abstract
// namespace). Probe both, so either backend reports "ready".
async function probeDisplay(displayNumber: number): Promise<boolean> {
  const suffix = `/tmp/.X11-unix/X${displayNumber}`
  if (await probeSocket(`\0${suffix}`)) return true
  return probeSocket(suffix)
}

// Attach a concise Chinese reason (for the WSL fallback warning) to an Error whose
// full message spells out the headless fix. The reason is the human-readable cause
// without the "无 DISPLAY" framing, which is wrong when a DISPLAY already exists.
function fail(reason: string, message: string): Error {
  return Object.assign(new Error(message), { reason })
}

// Spawn `Xvfb :<N>` and wait until its socket accepts connections. Resolves to
// the live child when ready, `undefined` when it died before becoming ready
// (typically "server already running" — the number is taken), and rejects on a
// missing Xvfb (ENOENT) or a startup timeout.
function startCandidate(displayNumber: number): Promise<ChildProcess | undefined> {
  return new Promise((resolve, reject) => {
    const child = spawn('Xvfb', [`:${displayNumber}`, '-screen', '0', XVFB_SCREEN], {
      stdio: ['ignore', 'ignore', 'pipe'],
    })

    // Xvfb's stderr is inherent noise — xkbcomp keysym warnings (~20 lines) and a
    // unix-socket bind warning fire on every successful start and mean nothing for
    // the test. They only have diagnostic value when a candidate never becomes
    // ready, so buffer a bounded tail instead of forwarding it, and surface it only
    // on the startup-timeout failure path.
    let stderrTail = ''
    const onStderrData = (chunk: Buffer): void => {
      stderrTail = (stderrTail + chunk.toString()).slice(-STDERR_TAIL_MAX)
    }
    child.stderr?.on('data', onStderrData)

    let settled = false
    let probeTimer: ReturnType<typeof setInterval> | undefined = undefined
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined = undefined

    function finish(done: () => void): void {
      if (settled) return
      settled = true
      if (probeTimer !== undefined) clearInterval(probeTimer)
      if (timeoutTimer !== undefined) clearTimeout(timeoutTimer)
      child.removeListener('error', onError)
      child.removeListener('exit', onExit)
      child.stderr?.removeListener('data', onStderrData)
      done()
    }

    function onError(err: Error): void {
      // spawn never throws synchronously; ENOENT arrives here and means Xvfb is
      // not installed. Keep the raw error for the underlying detail.
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        finish(() =>
          reject(
            fail(
              '未安装 Xvfb',
              `[e2e] 无 DISPLAY 且未安装 Xvfb，Electron 无法启动（${String(err)}）。${XVFB_FIX_HINT}`,
            ),
          ),
        )
      } else {
        // Any other spawn failure leaves no process behind; treat it like a
        // dead candidate and move on to the next number.
        finish(() => resolve(undefined))
      }
    }

    function onExit(): void {
      finish(() => resolve(undefined))
    }

    child.on('error', onError)
    child.on('exit', onExit)

    timeoutTimer = setTimeout(() => {
      finish(() => {
        child.kill('SIGKILL')
        const tail = stderrTail.trim()
        reject(
          fail(
            '启动超时',
            `[e2e] 无 DISPLAY 且 Xvfb 启动超时（${XVFB_START_TIMEOUT_MS}ms），Electron 无法启动。${XVFB_FIX_HINT}` +
              (tail ? `\nXvfb stderr（尾部）：\n${tail}` : ''),
          ),
        )
      })
    }, XVFB_START_TIMEOUT_MS)

    probeTimer = setInterval(() => {
      void probeDisplay(displayNumber).then((ready) => {
        if (ready) finish(() => resolve(child))
      })
    }, PROBE_INTERVAL_MS)
  })
}

export default async function globalSetup(): Promise<(() => void) | undefined> {
  if (process.platform !== 'linux') return
  // Falsy (not `!== undefined`): `DISPLAY= pnpm e2e` sets an EMPTY string, and
  // Electron treats an empty DISPLAY as missing ("Missing X server or $DISPLAY"), so
  // we must too — this also keeps the check consistent with linux-preflight's
  // checkDisplay.
  const hasDisplay = Boolean(process.env['DISPLAY'])
  // WSLg exports DISPLAY=:0 even though WSL e2e is documented as zero-distraction,
  // so default to offscreen Xvfb there too. UNIVERSE_E2E_SHOW (falsy check, matching
  // apps/editor/src/main/index.ts silentE2E) opts back into the real window — the
  // e2e:headed / e2e:ui scripts set it.
  const wantOffscreen = !hasDisplay || (isWsl() && !process.env['UNIVERSE_E2E_SHOW'])
  if (!wantOffscreen) return

  try {
    for (let displayNumber = DISPLAY_START; displayNumber <= DISPLAY_END; displayNumber++) {
      // Quick, non-authoritative filter: a leftover lock file usually means the
      // display is (or recently was) in use. The socket probe is the real gate.
      if (existsSync(`/tmp/.X${displayNumber}-lock`)) continue
      const child = await startCandidate(displayNumber)
      if (child === undefined) continue

      process.env['DISPLAY'] = `:${displayNumber}`
      if (hasDisplay) {
        console.warn(
          `[e2e] WSL 检测到 DISPLAY 但默认离屏，已启动 Xvfb（DISPLAY=:${displayNumber}；UNIVERSE_E2E_SHOW=1 恢复真实窗口）`,
        )
      } else {
        console.warn(`[e2e] 未检测到 DISPLAY，已自动启动 Xvfb（DISPLAY=:${displayNumber}）`)
      }

      // Teardown reaps the Xvfb process the whole run depended on. `kill` returns
      // false (never throws) if it already exited; the try/catch is belt-and-braces.
      const started = child
      return () => {
        try {
          started.kill('SIGTERM')
        } catch {
          // Already gone.
        }
      }
    }

    throw fail(
      '未找到空闲 display 编号',
      `[e2e] 无 DISPLAY 且未找到空闲 display（已尝试 :${DISPLAY_START}–:${DISPLAY_END}），Electron 无法启动。${XVFB_FIX_HINT}`,
    )
  } catch (err) {
    // WSL 覆盖模式：任何失败（未装 Xvfb / 编号耗尽 / 启动超时）都不致命——已有
    // DISPLAY 兜底，回退 WSLg/现有 DISPLAY 的真实窗口，而非让整趟 e2e 失败。
    if (hasDisplay) {
      const reason = (err as { reason?: string }).reason ?? '未知原因'
      console.warn(
        `[e2e] Xvfb 不可用（${reason}），回退 WSLg/现有 DISPLAY 真实窗口；装 xvfb 可获零窗口：bash scripts/wsl/bootstrap.sh`,
      )
      return undefined
    }
    throw err
  }
}
