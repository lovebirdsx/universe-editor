/**
 * Process-level I/O sampling for the sync status bar: the "is p4 actually
 * working?" signal that the file watcher cannot provide.
 *
 * The watcher-derived `disk +N` counter counts writes into the *workspace*, and
 * a wide sync spends its first minutes (and every `--parallel` batch gap)
 * without touching a single workspace file — p4 is walking the depot server-side
 * and staging downloads. During that window `done` and `disk +N` are both frozen
 * at 0 and the bar reads as stalled, which is exactly what this probe fixes: the
 * p4 process's own read counter climbs from the first server round-trip on.
 *
 * Sources, in preference order:
 * - `UNIVERSE_P4_IO_PROBE=off` disables sampling (e2e keeps it off); any other
 *   value is a command to run as the sampler (test seam, same shape as
 *   `UNIVERSE_P4_PATH`).
 * - win32: a long-lived `powershell.exe` sampler polling WMI once a second. Node
 *   has no child-process I/O counter of its own, and the only OS route is
 *   `Win32_Process.ReadTransferCount` (= `GetProcessIoCounters`, the same
 *   counter Task Manager shows) — reachable from Node only through WMI.
 * - linux: `/proc/<pid>/io` directly (no subprocess).
 * - darwin: unimplemented → no probe, and the bar falls back to the disk count.
 *
 * Deliberately NOT `p4 -I`: the progress protocol disables `--parallel` (see
 * docs/pitfalls.md), and a serial transfer is unacceptable on a giant depot.
 *
 * Counters are read across the probe's process *tree* (the sync plus the workers
 * `--parallel` forks), and every tick reports a DELTA rather than a running
 * total: a worker appearing mid-sync (its counter starts near zero) or leaving
 * it (its total would vanish from the sum) must not be read as a spike or a
 * negative. A pid recycled during the sync then compares against zero, not
 * against a dead process's totals.
 *
 * Nothing here may throw into the extension host: the sample callbacks run from
 * async child-process handlers, where an exception becomes an uncaughtException
 * that kills the whole host (CLAUDE.md red line 4).
 */
import { spawn } from 'node:child_process'
import { readFile, readdir } from 'node:fs/promises'

/** One tick's transfer counts, in bytes. `read` is the receive side — socket
 *  reads plus anything p4 stages locally — which is what climbs during the
 *  transfer; `write` is the same tick's write side (kept for the tooltip). */
export interface P4IoSample {
  readonly read: number
  readonly write: number
}

export interface P4IoProbe {
  dispose(): void
}

export interface P4IoProbeOptions {
  readonly onSample: (sample: P4IoSample) => void
  /** The probe gave up before the sampled process ended: at most once per probe,
   *  and never for a normal end of life (the sampled process exiting is how every
   *  sync ends, so there is nothing to report then). `kind` is the caller's only
   *  decision input — see {@link P4IoProbeFailureKind}. */
  readonly onUnavailable: (reason: string, kind: P4IoProbeFailureKind) => void
  readonly log?: ((message: string) => void) | undefined
}

/** Sampling period. One second matches the status bar heartbeat, so the
 *  displayed rate is recomputed once per sample rather than interpolated. */
export const PROBE_POLL_MS = 1000

/** Stop sampling after this long with nothing transferred. Not a lifetime cap:
 *  a `p4 sync` runs watchdog-free (`CONTENT_TRANSFER_EXEC`) and a whole-repo pull
 *  legitimately takes tens of minutes, so the sampler must never cut a live
 *  transfer off — but it must also not outlive everything that could stop it
 *  (an editor crash leaves nothing to dispose the probe, and a wedged p4 that
 *  outlives the editor stays alive forever). Silence covers both. */
export const PROBE_IDLE_TIMEOUT_MS = 15 * 60 * 1000

/**
 * Why a sampler stopped, in the only distinction its caller acts on: `'missing'`
 * means this machine has no usable source (the sampler could not be started, or
 * started without executing a single line), so paying for another one on the
 * next sync is pointless. `'transient'` means this particular run went wrong —
 * a stalled or wedged sampler, a busy WMI provider, a transfer that went quiet —
 * and the next sync deserves a fresh attempt.
 */
export type P4IoProbeFailureKind = 'missing' | 'transient'

/** Give up when the sampler hasn't printed a line this long after spawn (or
 *  after its last line — a wedged WMI hangs the loop, it doesn't exit). */
const PROBE_STALL_TIMEOUT_MS = 15_000

/** Consecutive failed WMI queries before the Windows sampler declares the
 *  source dead. One failure is noise (the provider is busy for a beat). */
const PROBE_MAX_QUERY_FAILURES = 5

/** The sliding window the displayed rate averages over. Long enough to ride out
 *  p4's bursty staging, short enough that stopping shows up within a few
 *  seconds. */
export const RATE_WINDOW_MS = 5000

/**
 * One line of the sampler's stdout, or `'error'` for its give-up line, or
 * undefined for anything unrecognized (which is ignored, never fatal).
 *
 * The protocol is two ASCII tokens (`S <readDelta> <writeDelta>`) so it parses
 * identically on every platform regardless of the sampler's own locale.
 */
export function parseSamplerLine(line: string): P4IoSample | 'error' | undefined {
  const trimmed = line.trim()
  if (trimmed === '') return undefined
  // `E` alone or `E <reason>`, never `Exiting`: an unprefixed word that merely
  // starts with E (a PowerShell banner, a stray message) must stay ignored.
  if (trimmed === 'E' || trimmed.startsWith('E ')) return 'error'
  const match = /^S\s+(\d+)\s+(\d+)$/.exec(trimmed)
  if (!match) return undefined
  const read = Number(match[1])
  const write = Number(match[2])
  if (!Number.isFinite(read) || !Number.isFinite(write)) return undefined
  return { read, write }
}

/**
 * The unit ladder for {@link formatIoRate}. No `B/s` tier on purpose: the unit
 * is then always 4 characters wide, which is half of what keeps the readout from
 * jittering (see below).
 */
const RATE_UNITS: readonly { readonly unit: string; readonly scale: number }[] = [
  { unit: 'KB/s', scale: 1024 },
  { unit: 'MB/s', scale: 1024 ** 2 },
  { unit: 'GB/s', scale: 1024 ** 3 },
  { unit: 'TB/s', scale: 1024 ** 4 },
]

/**
 * Format a byte rate as a FIXED-WIDTH status-bar token: three digits plus a
 * 4-character unit, always 7 characters (`000KB/s`, `042MB/s`, `300MB/s`,
 * `001GB/s`).
 *
 * Width stability is the point — the status bar lays entries out in a row, so a
 * token that grows a character every time the rate crosses 10 or 100 shoves
 * every neighbouring entry sideways once a second. Padding with spaces cannot
 * fix that (HTML collapses runs of spaces; U+00A0 and U+2007 are not digit-wide
 * in every UI font, and a missing glyph falls back to a different font
 * entirely), so the pad character is a digit: leading zeros, plus
 * `font-variant-numeric: tabular-nums` on the status bar so digits share one
 * advance width. The unit still changes width across tiers, but only when the
 * rate crosses a 1000× boundary, not per tick.
 *
 * Source-agnostic: the status bar feeds it the sync's read + write process-I/O
 * total (a read-only figure decays to zero while p4 writes the workspace files).
 *
 * `undefined` means "no probe" — the caller falls back to the disk count.
 */
export function formatIoRate(bytesPerSecond: number | undefined): string | undefined {
  if (bytesPerSecond === undefined) return undefined
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond < 0) return undefined
  let unit = 'KB/s'
  let scale = 1024
  for (const entry of RATE_UNITS) {
    // Largest tier the rate reaches, so the mantissa lands in [1, 1024) and the
    // clamp below only ever bites in the narrow [1000, 1024) hand-off band.
    if (bytesPerSecond >= entry.scale) {
      unit = entry.unit
      scale = entry.scale
    }
  }
  // The 1000× thresholds keep the mantissa in [0, 999]: a rate in the narrow
  // [1000, 1024) band of a tier reads as that tier's 999 without ever emitting a
  // fourth digit (and therefore without changing the token's width).
  const mantissa = Math.min(999, Math.round(bytesPerSecond / scale))
  return `${String(mantissa).padStart(3, '0')}${unit}`
}

/**
 * A cumulative byte count for a tooltip (`842KB`, `1.2GB`). Not width-stable —
 * a tooltip is prose, so exact figures matter more than a fixed column here; the
 * status-bar token is what has to hold its width.
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0B'
  if (bytes < 1024) return `${Math.round(bytes)}B`
  if (bytes < 1024 ** 2) return `${Math.round(bytes / 1024)}KB`
  if (bytes < 1024 ** 3) return `${Math.round(bytes / 1024 ** 2)}MB`
  return `${(bytes / 1024 ** 3).toFixed(1)}GB`
}

/**
 * A sliding-window rate over cumulative byte counts.
 *
 * Samples are pushed at RENDER time (the status bar's 1s heartbeat plus every
 * client emit), not when bytes arrive — that is what makes the rate decay: once
 * the writes stop, the window slides off the growth and the numerator goes to
 * zero on its own, without needing another event. The denominator runs to `now`
 * rather than to the newest sample, so the number slides down instead of
 * snapping once the samples go stale.
 */
export class RateWindow {
  private readonly _samples: { t: number; bytes: number }[] = []

  constructor(private readonly _windowMs: number = RATE_WINDOW_MS) {}

  push(now: number, bytes: number): void {
    this._samples.push({ t: now, bytes })
    const cutoff = now - this._windowMs
    // Drop everything that fell out of the window, but keep the last sample
    // before it as the anchor. Without an anchor a slower cadence than one
    // sample per window (the render thread was busy) collapses the window to a
    // single point, which reads as "no rate" — a false stall while bytes are
    // still arriving.
    let keep = 0
    while (keep + 1 < this._samples.length && this._samples[keep + 1]!.t < cutoff) keep++
    if (keep > 0) this._samples.splice(0, keep)
  }

  /** Bytes/second across the retained window, or undefined while the window is
   *  still a single point (nothing to difference against). */
  rateAt(now: number): number | undefined {
    const oldest = this._samples[0]
    const newest = this._samples[this._samples.length - 1]
    if (!oldest || !newest || newest === oldest) return undefined
    const seconds = (now - oldest.t) / 1000
    if (seconds <= 0) return undefined
    return Math.max(0, (newest.bytes - oldest.bytes) / seconds)
  }

  /** Drop the window's history — a new sync run must not difference against the
   *  previous run's totals. */
  reset(): void {
    this._samples.length = 0
  }
}

/**
 * The Windows sampler script, run through `-EncodedCommand` so no part of it
 * ever reaches a command line (Windows argv quoting is a documented minefield
 * here — see the `win32-spawnsync-cmd-caret-escaping` note).
 *
 * Exits on its own when the sampled process disappears, which is the normal end
 * of every sync — including the case where the editor crashed and nothing is
 * left to dispose the probe.
 */
export function buildWindowsSamplerScript(pid: number): string {
  return [
    "$ErrorActionPreference = 'SilentlyContinue'",
    `$root = ${pid}`,
    '$prev = @{}',
    '$fails = 0',
    '$idleSince = [DateTime]::UtcNow',
    // Emitted before the first query on purpose: it proves the script ran at all.
    // Without it, "closed having printed nothing" is ambiguous — a p4 that exited
    // before the first poll and a machine where PowerShell cannot execute the
    // script look identical — and the caller treats exactly that case as a broken
    // source it need not retry.
    "[Console]::Out.WriteLine('S 0 0')",
    // No wall-clock deadline: a whole-repo pull legitimately runs for tens of
    // minutes, and cutting the sampler off in the middle of one would freeze the
    // readout at `000KB/s` — the false "stalled" signal this probe exists to
    // remove. What the deadline was really for is not outliving a dead editor,
    // and that is covered by two exits that don't depend on wall-clock at all:
    // the root-liveness check below (p4 gone → we're done) and this idle rule
    // (nothing transferred for ${PROBE_IDLE_TIMEOUT_MS / 60000} minutes → either
    // the transfer is dead or nothing is left to watch).
    'while ($true) {',
    '  if ($null -eq (Get-Process -Id $root -ErrorAction SilentlyContinue)) { break }',
    '  $procs = Get-CimInstance -ClassName Win32_Process ' +
      '-Filter "ProcessId=$root or ParentProcessId=$root" ' +
      '-Property ProcessId,ReadTransferCount,WriteTransferCount -ErrorAction SilentlyContinue',
    '  if ($null -eq $procs) {',
    '    $fails = $fails + 1',
    `    if ($fails -ge ${PROBE_MAX_QUERY_FAILURES}) { [Console]::Out.WriteLine('E wmi'); break }`,
    "    [Console]::Out.WriteLine('S 0 0')",
    `    Start-Sleep -Milliseconds ${PROBE_POLL_MS}`,
    '    continue',
    '  }',
    '  $fails = 0',
    '  $next = @{}',
    '  $dr = [uint64]0',
    '  $dw = [uint64]0',
    '  foreach ($p in $procs) {',
    '    $id = [int]$p.ProcessId',
    '    $r = [uint64]$p.ReadTransferCount',
    '    $w = [uint64]$p.WriteTransferCount',
    '    $old = $prev[$id]',
    '    if ($null -eq $old) { $dr = $dr + $r; $dw = $dw + $w }',
    '    else {',
    '      if ($r -gt $old[0]) { $dr = $dr + ($r - $old[0]) }',
    '      if ($w -gt $old[1]) { $dw = $dw + ($w - $old[1]) }',
    '    }',
    '    $next[$id] = @($r, $w)',
    '  }',
    // Rebuilt every tick: only pids still in the tree keep an entry, so a pid
    // recycled after its process exited can't be differenced against the dead
    // process's totals.
    '  $prev = $next',
    '  if ($dr -eq 0 -and $dw -eq 0) {',
    `    if (([DateTime]::UtcNow - $idleSince).TotalSeconds -ge ${PROBE_IDLE_TIMEOUT_MS / 1000}) {`,
    "      [Console]::Out.WriteLine('E idle')",
    '      break',
    '    }',
    '  } else {',
    '    $idleSince = [DateTime]::UtcNow',
    '  }',
    '  [Console]::Out.WriteLine("S $dr $dw")',
    `  Start-Sleep -Milliseconds ${PROBE_POLL_MS}`,
    '}',
  ].join('\n')
}

/**
 * Create a probe for `pid`, or undefined when this platform has no source (the
 * caller then falls back to the watcher-derived disk count).
 */
export function createP4IoProbe(pid: number, options: P4IoProbeOptions): P4IoProbe | undefined {
  if (!Number.isInteger(pid) || pid <= 0) return undefined
  const override = process.env.UNIVERSE_P4_IO_PROBE
  if (override === 'off') return undefined
  if (override) return createCommandProbe(override, pid, options)
  if (process.platform === 'win32') return createWindowsProbe(pid, options)
  if (process.platform === 'linux') return createLinuxProbe(pid, options)
  return undefined
}

/** `UNIVERSE_P4_IO_PROBE=<path>`: a sampler command the caller supplies (the e2e
 *  seam). Script paths run through the current runtime, mirroring
 *  {@link import('./p4Service.js').resolveP4Command}. */
function createCommandProbe(
  command: string,
  pid: number,
  options: P4IoProbeOptions,
): P4IoProbe | undefined {
  const isScript = /\.[mc]?js$/.test(command)
  if (!isScript) return spawnSampler(command, [String(pid)], options)
  // `process.execPath` here is Electron, and the extension host is Electron-as-
  // node: without re-adding the flag the "script" child would start a whole
  // second editor window instead (same trap p4Service documents for the fake p4).
  return spawnSampler(process.execPath, [command, String(pid)], options, {
    ...probeEnv(),
    ELECTRON_RUN_AS_NODE: '1',
  })
}

/** Environment for a sampler child: inherited, minus the variables that would
 *  change how the child runtime starts — `NODE_OPTIONS=--inspect` would open a
 *  debug port on the sampler of every sync. Mirrors p4Service's denylist. */
function probeEnv(): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (key === 'NODE_OPTIONS' || key === 'ELECTRON_RUN_AS_NODE') continue
    out[key] = value
  }
  return out
}

function createWindowsProbe(pid: number, options: P4IoProbeOptions): P4IoProbe | undefined {
  const script = buildWindowsSamplerScript(pid)
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  return spawnSampler(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
    options,
    probeEnv(),
  )
}

/**
 * Run one sampler process and turn its stdout into samples. Shared by the
 * Windows and override paths.
 *
 * Every async handler is wrapped: a throw here would escape into the extension
 * host's uncaughtException handler and take every extension down with it.
 */
function spawnSampler(
  command: string,
  args: readonly string[],
  options: P4IoProbeOptions,
  env: NodeJS.ProcessEnv = probeEnv(),
): P4IoProbe | undefined {
  let child: ReturnType<typeof spawn>
  try {
    child = spawn(command, [...args], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
      env,
    })
  } catch (err) {
    options.log?.(`[perforce] sync io probe unavailable: ${String(err)}`)
    return undefined
  }

  let disposed = false
  let sampled = false
  let carry = ''
  let stall: ReturnType<typeof setTimeout> | undefined

  const stop = (): void => {
    if (stall !== undefined) {
      clearTimeout(stall)
      stall = undefined
    }
  }
  const giveUp = (reason: string, kind: P4IoProbeFailureKind): void => {
    if (disposed) return
    disposed = true
    stop()
    try {
      child.kill()
    } catch {
      // best-effort
    }
    // Runs from async handlers (stdout data, the stall timer, `error`/`close`)
    // where a throw would become an uncaughtException and kill the extension
    // host — the consumer's handler is wrapped like `onSample` is.
    try {
      options.onUnavailable(reason, kind)
    } catch (err) {
      options.log?.(`[perforce] sync io probe onUnavailable threw: ${String(err)}`)
    }
  }
  const armStall = (): void => {
    stop()
    stall = setTimeout(
      () => giveUp(`no output for ${PROBE_STALL_TIMEOUT_MS}ms`, 'transient'),
      PROBE_STALL_TIMEOUT_MS,
    )
    stall.unref?.()
  }

  armStall()
  child.stdout?.on('data', (chunk: Buffer) => {
    if (disposed) return
    try {
      carry += chunk.toString('utf8')
      const lines = carry.split(/\r?\n/)
      carry = lines.pop() ?? ''
      for (const line of lines) {
        const parsed = parseSamplerLine(line)
        if (parsed === undefined) continue
        if (parsed === 'error') {
          // The sampler named its own reason (`E wmi`, `E idle`) — pass it
          // through, and treat it as this run's problem rather than this
          // machine's: every one of these can be load or a stalled transfer.
          giveUp(`sampler reported: ${line.trim()}`, 'transient')
          return
        }
        sampled = true
        armStall()
        options.onSample(parsed)
      }
    } catch (err) {
      // Async data handler — never let a consumer or parser throw escape.
      options.log?.(`[perforce] sync io probe line failed: ${String(err)}`)
    }
  })
  child.on('error', (err) => giveUp(String(err), 'missing'))
  child.on('close', () => {
    // A probe that produced samples and then exited ended because the sampled
    // process did (its normal end of life — the sync's own teardown disposes us
    // first, this is the crash/edge path). Only a silent death means the source
    // itself is broken, and only that should latch the session off.
    if (!sampled) giveUp('sampler exited with no output', 'missing')
    else stop()
  })

  return {
    dispose(): void {
      if (disposed) return
      disposed = true
      stop()
      try {
        child.kill()
      } catch {
        // best-effort
      }
    },
  }
}

/** The probe's direct children: `/proc/<pid>/task/<tid>/children` is one small
 *  read per thread and lists exactly what we need (a `/proc` sweep per tick
 *  would be hundreds of opens for the same answer). */
async function readTreePids(pid: number): Promise<number[]> {
  const pids = [pid]
  try {
    const tids = await readdir(`/proc/${pid}/task`)
    for (const tid of tids) {
      const children = await readFile(`/proc/${pid}/task/${tid}/children`, 'utf8')
      for (const token of children.trim().split(/\s+/)) {
        const child = Number(token)
        if (Number.isInteger(child) && child > 0 && !pids.includes(child)) pids.push(child)
      }
    }
  } catch {
    // No children readable (hidepid, a threads-less kernel, or the process is
    // gone) — the root's own counters are still worth reporting.
  }
  return pids
}

/** Cumulative `rchar`/`wchar` for one process. `rchar` (not `read_bytes`) is the
 *  receive side: p4 pulls archives over the socket, and `read_bytes` counts only
 *  block-device reads, which stay near zero for a network fetch. */
async function readProcIo(pid: number): Promise<P4IoSample | undefined> {
  try {
    const text = await readFile(`/proc/${pid}/io`, 'utf8')
    let read: number | undefined
    let write: number | undefined
    for (const line of text.split('\n')) {
      const [key, value] = line.split(':')
      if (key === 'rchar') read = Number(value)
      else if (key === 'wchar') write = Number(value)
    }
    if (read === undefined || write === undefined) return undefined
    if (!Number.isFinite(read) || !Number.isFinite(write)) return undefined
    return { read, write }
  } catch {
    return undefined
  }
}

function createLinuxProbe(pid: number, options: P4IoProbeOptions): P4IoProbe {
  let disposed = false
  let sampled = false
  let failures = 0
  let running = false
  let timer: ReturnType<typeof setInterval> | undefined
  const prev = new Map<number, P4IoSample>()

  const stop = (): void => {
    if (timer !== undefined) {
      clearInterval(timer)
      timer = undefined
    }
  }

  const tick = async (): Promise<void> => {
    if (disposed || running) return
    running = true
    try {
      let read = 0
      let write = 0
      let sawRoot = false
      const next = new Map<number, P4IoSample>()
      for (const target of await readTreePids(pid)) {
        const current = await readProcIo(target)
        if (current === undefined) continue
        if (target === pid) sawRoot = true
        const previous = prev.get(target)
        if (previous === undefined) {
          read += current.read
          write += current.write
        } else {
          if (current.read > previous.read) read += current.read - previous.read
          if (current.write > previous.write) write += current.write - previous.write
        }
        next.set(target, current)
      }
      // The loop above awaits one tiny read per pid, so a dispose (sync finished,
      // watchdog killed p4) can land mid-tick. Re-check before emitting rather
      // than reporting on a run the caller has already torn down.
      if (disposed) return
      if (!sawRoot) {
        // The process is gone (or its /proc entry is unreadable). No sample is
        // ever produced from here on, so stop — but do NOT report the source as
        // unusable: a sync that finished before this first tick is
        // indistinguishable from an unreadable /proc, and the caller's latch
        // would then cost every later sync in the session its rate readout.
        disposed = true
        stop()
        return
      }
      failures = 0
      sampled = true
      prev.clear()
      for (const [key, value] of next) prev.set(key, value)
      options.onSample({ read, write })
    } catch (err) {
      failures++
      if (failures >= PROBE_MAX_QUERY_FAILURES && !sampled) {
        disposed = true
        stop()
        // Same guard as the Windows path: this runs off a timer, and a throw
        // here would surface as an uncaughtException in the extension host.
        try {
          options.onUnavailable(String(err), 'transient')
        } catch (handlerErr) {
          options.log?.(`[perforce] sync io probe onUnavailable threw: ${String(handlerErr)}`)
        }
      }
    } finally {
      running = false
    }
  }

  timer = setInterval(() => {
    void tick()
  }, PROBE_POLL_MS)
  timer.unref?.()

  return {
    dispose(): void {
      disposed = true
      stop()
    },
  }
}
