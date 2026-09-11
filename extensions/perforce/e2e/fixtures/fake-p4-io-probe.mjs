#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  Fake p4 I/O sampler for e2e (the `UNIVERSE_P4_IO_PROBE` seam).
 *
 *  The real sampler is per-platform: a long-lived PowerShell poller over WMI on
 *  Windows, `/proc/<pid>/io` on Linux, nothing on macOS. None of those is
 *  pinnable from a test — the first two report whatever the machine happens to
 *  be doing — so the wire protocol is what the e2e drives instead: this script
 *  is spawned with the p4 pid and emits a per-tick delta the spec can compute.
 *
 *  Each tick's delta is one step LARGER than the last (`STEP_BYTES * ticks`),
 *  which makes the rate climb instead of sitting at a constant. That is what
 *  lets the spec assert the token's text actually changed between samples — a
 *  constant rate models a healthy transfer but makes "the number moved" true
 *  only by rounding luck.
 *
 *  `UNIVERSE_P4_FAKE_IO_WRITE_FROM_TICK` models the second half of a real sync:
 *  from that tick on the deltas go to the WRITE counter and the read counter
 *  freezes where it stopped, which is what p4 does once it stops pulling from
 *  the server and starts landing the staged content in the workspace.
 *
 *  Speaks the same two ASCII tokens as the real samplers (`S <read> <write>`),
 *  plus the startup line: the extension latches the sampler off for the session
 *  when one closes having printed nothing (that is a machine where PowerShell
 *  cannot run the script at all), so a well-behaved sampler always opens with a
 *  line even when it has nothing to report yet. Ignoring the pid is fine — the
 *  fake p4 does not fork workers, so there is no process tree to walk.
 *
 *  Self-limiting: it exits after MAX_TICKS so a test that ends mid-sync cannot
 *  leave a stray timer behind for the harness teardown to reap.
 *--------------------------------------------------------------------------------------------*/

const STEP_BYTES = Number(process.env.UNIVERSE_P4_FAKE_IO_STEP ?? String(8 * 1024 * 1024))
const TICK_MS = Number(process.env.UNIVERSE_P4_FAKE_IO_TICK_MS ?? '1000')
const WRITE_FROM_TICK = Number(process.env.UNIVERSE_P4_FAKE_IO_WRITE_FROM_TICK ?? '0')
const MAX_TICKS = 60

process.stdout.write('S 0 0\n')
let ticks = 0
const timer = setInterval(() => {
  if (++ticks > MAX_TICKS) {
    clearInterval(timer)
    return
  }
  const delta = STEP_BYTES * ticks
  const writing = WRITE_FROM_TICK > 0 && ticks >= WRITE_FROM_TICK
  process.stdout.write(writing ? `S 0 ${delta}\n` : `S ${delta} 0\n`)
}, TICK_MS)
