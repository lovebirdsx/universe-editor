/**
 * The sync I/O probe: the sampler line protocol, the fixed-width rate token, the
 * sliding-window rate, and (per platform) how a sampler's output, death and
 * disposal are handled. The readout's whole point is that it is legible while
 * p4 is silent, so the width invariant and the decay-to-zero are pinned here.
 */
import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { P4IoProbe } from '../processIo.js'

class FakeChildProcess extends EventEmitter {
  readonly stdout = new EventEmitter()
  readonly stderr = new EventEmitter()
  readonly stdin = { end: vi.fn() }
  readonly killed: boolean[] = []
  kill = vi.fn(() => {
    this.killed.push(true)
    return true
  })
}

const spawnMock = vi.fn<(...args: unknown[]) => FakeChildProcess>()
vi.mock('node:child_process', () => ({ spawn: (...args: unknown[]) => spawnMock(...args) }))

const fsState = vi.hoisted(() => ({
  files: new Map<string, string>(),
  dirs: new Map<string, string[]>(),
}))

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(async (path: string) => {
    const value = fsState.files.get(String(path))
    if (value === undefined) throw new Error(`ENOENT: ${String(path)}`)
    return value
  }),
  readdir: vi.fn(async (path: string) => {
    const value = fsState.dirs.get(String(path))
    if (value === undefined) throw new Error(`ENOENT: ${String(path)}`)
    return value
  }),
}))

const {
  createP4IoProbe,
  formatBytes,
  formatIoRate,
  parseSamplerLine,
  buildWindowsSamplerScript,
  RateWindow,
} = await import('../processIo.js')

const ORIGINAL_PROBE = process.env.UNIVERSE_P4_IO_PROBE
const ORIGINAL_PLATFORM = Object.getOwnPropertyDescriptor(process, 'platform')

function setPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value, configurable: true })
}

/** Drive the probe the way the OS would: stdout chunks + lifecycle events. */
function emitLines(child: FakeChildProcess, text: string): void {
  child.stdout.emit('data', Buffer.from(text))
}

/** Drain the microtask queue so a tick's awaited (mocked) /proc reads settle. */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

describe('parseSamplerLine', () => {
  it('parses the two-token delta line', () => {
    expect(parseSamplerLine('S 1024 64')).toEqual({ read: 1024, write: 64 })
    expect(parseSamplerLine('S 0 0')).toEqual({ read: 0, write: 0 })
    expect(parseSamplerLine('  S 7 9  \r')).toEqual({ read: 7, write: 9 })
  })

  it('reports the sampler giving up', () => {
    expect(parseSamplerLine('E wmi')).toBe('error')
    expect(parseSamplerLine('E')).toBe('error')
  })

  it('ignores anything else rather than guessing', () => {
    for (const line of [
      '',
      '   ',
      'S',
      'S 1',
      'S a b',
      'S -1 2',
      'progress 1/2',
      '# comment',
      // A word that merely starts with E is not the sampler's give-up line.
      'Exiting',
      'ERROR: something',
    ]) {
      expect(parseSamplerLine(line)).toBeUndefined()
    }
  })
})

describe('formatIoRate', () => {
  it('is undefined only when there is no rate at all', () => {
    expect(formatIoRate(undefined)).toBeUndefined()
    expect(formatIoRate(Number.NaN)).toBeUndefined()
    expect(formatIoRate(-1)).toBeUndefined()
  })

  it('picks a tier and pads the mantissa to three digits', () => {
    expect(formatIoRate(0)).toBe('000KB/s')
    expect(formatIoRate(1024)).toBe('001KB/s')
    expect(formatIoRate(420 * 1024)).toBe('420KB/s')
    expect(formatIoRate(42 * 1024 ** 2)).toBe('042MB/s')
    expect(formatIoRate(300 * 1024 ** 2)).toBe('300MB/s')
    expect(formatIoRate(1024 ** 3)).toBe('001GB/s')
    expect(formatIoRate(1024 ** 4)).toBe('001TB/s')
  })

  it('clamps the tier hand-off band instead of growing a fourth digit', () => {
    // [1000, 1024) of a tier is the only band where the mantissa would round to
    // 1000 — a wider token would shift every neighbouring status-bar entry.
    expect(formatIoRate(1000 * 1024 ** 2)).toBe('999MB/s')
    expect(formatIoRate(1000 * 1024 ** 4)).toBe('999TB/s')
  })

  it('keeps one width across the whole range', () => {
    const rates = [
      0,
      1,
      512,
      1023,
      1024,
      999 * 1024,
      1000 * 1024,
      5 * 1024 ** 2,
      999 * 1024 ** 2,
      1000 * 1024 ** 3,
      999 * 1024 ** 3,
      1000 * 1024 ** 4,
      999 * 1024 ** 4,
    ]
    const widths = new Set(rates.map((rate) => formatIoRate(rate)?.length))
    expect([...widths]).toEqual([7])
  })
})

describe('formatBytes', () => {
  it('rounds to a readable unit for a tooltip', () => {
    expect(formatBytes(0)).toBe('0B')
    expect(formatBytes(-1)).toBe('0B')
    expect(formatBytes(Number.NaN)).toBe('0B')
    expect(formatBytes(512)).toBe('512B')
    expect(formatBytes(4096)).toBe('4KB')
    expect(formatBytes(42 * 1024 ** 2)).toBe('42MB')
    expect(formatBytes(2.5 * 1024 ** 3)).toBe('2.5GB')
  })
})

describe('RateWindow', () => {
  it('has no rate from a single sample', () => {
    const window = new RateWindow(5000)
    window.push(1000, 0)
    expect(window.rateAt(1000)).toBeUndefined()
  })

  it('averages the growth across the retained window', () => {
    const window = new RateWindow(5000)
    window.push(1000, 0)
    window.push(2000, 1000)
    window.push(3000, 4000)
    // 4000 bytes over the 2s the window actually spans.
    expect(window.rateAt(3000)).toBe(2000)
  })

  it('keeps one anchor when the sample cadence is slower than the window', () => {
    const window = new RateWindow(5000)
    window.push(1000, 0)
    window.push(7000, 6000)
    // The 1s sample is outside the window and would be pruned, but it is the only
    // thing the newest sample can be differenced against — dropping it would read
    // as "no rate" instead of "6s worth of growth".
    expect(window.rateAt(7000)).toBe(1000)
  })

  it('slides the anchor along with a dense cadence instead of hoarding history', () => {
    const window = new RateWindow(5000)
    for (let t = 0; t <= 12_000; t += 1000) window.push(t, t)
    // Linear 1000 B/s: the rate is the same whether the span is 6s or 12s, so
    // assert the retained span directly — at most the window plus the one-sample
    // overshoot the anchor is allowed.
    const now = 12_000
    expect(window.rateAt(now)).toBe(1000)
    expect(
      now - (window as unknown as { _samples: { t: number }[] })._samples[0]!.t,
    ).toBeLessThanOrEqual(5000 + 1000)
  })

  it('decays to zero once the byte count stops moving', () => {
    const window = new RateWindow(5000)
    window.push(0, 0)
    window.push(1000, 1000)
    const moving = window.rateAt(1000)
    expect(moving).toBe(1000)
    // Writes stop: the heartbeat keeps sampling the same total, so the window
    // slides off the growth and the rate falls without any further event.
    window.push(2000, 1000)
    const coasting = window.rateAt(2000)
    expect(coasting).toBeLessThan(moving!)
    window.push(4000, 1000)
    window.push(6000, 1000)
    // The anchor still predates the stall, so the last of the growth is still in
    // the numerator here; it takes one more tick to roll it out of the window.
    window.push(7000, 1000)
    expect(window.rateAt(7000)).toBe(0)
  })

  it('resets between sync runs', () => {
    const window = new RateWindow(5000)
    window.push(0, 0)
    window.push(1000, 5000)
    window.reset()
    expect(window.rateAt(1000)).toBeUndefined()
    window.push(1000, 100)
    window.push(2000, 200)
    expect(window.rateAt(2000)).toBe(100)
  })
})

describe('buildWindowsSamplerScript', () => {
  it('polls the tree of the given pid and reports per-tick deltas', () => {
    const script = buildWindowsSamplerScript(4242)
    expect(script).toContain('$root = 4242')
    expect(script).toContain('ProcessId=$root or ParentProcessId=$root')
    expect(script).toContain('ReadTransferCount')
    expect(script).toContain('WriteTransferCount')
    expect(script).toContain('[Console]::Out.WriteLine("S $dr $dw")')
    // The startup line must come before the loop that can exit on a vanished
    // process: it is what separates "never ran" from "ran, nothing to report".
    expect(script.indexOf("'S 0 0'")).toBeGreaterThan(-1)
    expect(script.indexOf("'S 0 0'")).toBeLessThan(script.indexOf('while ('))
    // The sampled process disappearing is the normal end of every sync…
    expect(script).toContain('Get-Process -Id $root')
    // …and the only other exit is sustained silence, never a wall-clock cap: a
    // whole-repo pull legitimately runs for tens of minutes, and cutting the
    // sampler off mid-transfer would freeze the readout at 000KB/s.
    expect(script).toContain('$idleSince')
    expect(script).toContain("'E idle'")
    expect(script).toContain('while ($true)')
    expect(script).not.toMatch(/deadline|AddSeconds/)
  })
})

describe('createP4IoProbe', () => {
  beforeEach(() => {
    spawnMock.mockReset()
    fsState.files.clear()
    fsState.dirs.clear()
    delete process.env.UNIVERSE_P4_IO_PROBE
  })
  afterEach(() => {
    if (ORIGINAL_PROBE === undefined) delete process.env.UNIVERSE_P4_IO_PROBE
    else process.env.UNIVERSE_P4_IO_PROBE = ORIGINAL_PROBE
    if (ORIGINAL_PLATFORM) Object.defineProperty(process, 'platform', ORIGINAL_PLATFORM)
    vi.useRealTimers()
  })

  it('is off when asked, and for pids that cannot be sampled', () => {
    process.env.UNIVERSE_P4_IO_PROBE = 'off'
    setPlatform('win32')
    expect(createP4IoProbe(1234, { onSample: () => {}, onUnavailable: () => {} })).toBeUndefined()
    delete process.env.UNIVERSE_P4_IO_PROBE
    expect(createP4IoProbe(0, { onSample: () => {}, onUnavailable: () => {} })).toBeUndefined()
    expect(
      createP4IoProbe(Number.NaN, { onSample: () => {}, onUnavailable: () => {} }),
    ).toBeUndefined()
  })

  it('has no source on platforms without one', () => {
    setPlatform('darwin')
    expect(createP4IoProbe(1234, { onSample: () => {}, onUnavailable: () => {} })).toBeUndefined()
  })

  describe('win32 sampler process', () => {
    let child: FakeChildProcess
    const samples: { read: number; write: number }[] = []
    const unavailable: { reason: string; kind: string }[] = []

    beforeEach(() => {
      setPlatform('win32')
      child = new FakeChildProcess()
      spawnMock.mockReturnValue(child)
      samples.length = 0
      unavailable.length = 0
    })

    const start = () => {
      const probe = createP4IoProbe(4242, {
        onSample: (sample) => samples.push(sample),
        onUnavailable: (reason, kind) => unavailable.push({ reason, kind }),
      })
      expect(probe).toBeDefined()
      return probe!
    }

    it('runs PowerShell with the script encoded out of the command line', () => {
      start()
      const [command, argv] = spawnMock.mock.calls[0] as [string, string[]]
      expect(command).toBe('powershell.exe')
      // The invariant is that no part of the script reaches the command line —
      // Windows argv quoting is a minefield and the script is full of them.
      expect(argv).toHaveLength(4)
      expect(argv.slice(0, 3)).toEqual(['-NoProfile', '-NonInteractive', '-EncodedCommand'])
      expect(argv[3]).toMatch(/^[A-Za-z0-9+/]+=*$/)
      const decoded = Buffer.from(argv[3]!, 'base64').toString('utf16le')
      expect(decoded).toBe(buildWindowsSamplerScript(4242))
    })

    it('reports each parsed delta and survives a partial line', () => {
      start()
      emitLines(child, 'S 1000 20\nS 2000 40\nS 30')
      expect(samples).toEqual([
        { read: 1000, write: 20 },
        { read: 2000, write: 40 },
      ])
      emitLines(child, '00 60\n')
      expect(samples.at(-1)).toEqual({ read: 3000, write: 60 })
      expect(unavailable).toEqual([])
    })

    it('gives up once when the sampler reports an error, and kills it', () => {
      start()
      emitLines(child, 'S 10 0\nE wmi\n')
      // Transient, not missing: five failed WMI queries in a row is a busy or
      // restarting provider as easily as a broken one, and latching the session
      // off on it would cost every later sync its readout.
      expect(unavailable).toEqual([{ reason: 'sampler reported: E wmi', kind: 'transient' }])
      expect(child.kill).toHaveBeenCalled()
    })

    it('gives up when the process dies without ever producing output', () => {
      start()
      child.emit('close', 0)
      // Nothing ran at all — that is a missing source, not a bad run.
      expect(unavailable).toHaveLength(1)
      expect(unavailable[0]!.kind).toBe('missing')
    })

    it('does not give up when the sampler started and then found its process gone', () => {
      // The script prints its startup line before its first query, so a sync that
      // finished inside the sampler's start-up window looks like this: started,
      // nothing to report, closed. That is a normal fast sync, not a broken
      // source — latching it off would disable the rate for the whole session.
      const probe = start()
      emitLines(child, 'S 0 0\n')
      child.emit('close', 0)
      expect(unavailable).toEqual([])
      probe.dispose()
    })

    it('does not latch the session off when a sampled process simply ends', () => {
      // The sampled p4 exiting is how every sync ends — the bar must keep
      // working for the next one.
      const probe = start()
      emitLines(child, 'S 10 0\n')
      child.emit('close', 0)
      expect(unavailable).toEqual([])
      probe.dispose()
      expect(unavailable).toEqual([])
    })

    it('gives up when the sampler stalls without printing', async () => {
      vi.useFakeTimers()
      start()
      emitLines(child, 'S 10 0\n')
      await vi.advanceTimersByTimeAsync(16_000)
      expect(unavailable).toEqual([{ reason: 'no output for 15000ms', kind: 'transient' }])
      expect(child.kill).toHaveBeenCalled()
    })

    it('survives a throwing consumer instead of taking the host down', () => {
      createP4IoProbe(4242, {
        onSample: () => {},
        onUnavailable: () => {
          throw new Error('consumer blew up')
        },
      })
      // The stdout handler has its own try/catch, but the close and stall paths
      // do not: a throw there escapes into the host's uncaughtException handler
      // and takes every extension down with it.
      expect(() => child.emit('close', 0)).not.toThrow()
    })

    it('stops the child on dispose and ignores an error that arrives later', () => {
      const probe = start()
      emitLines(child, 'S 10 0\n')
      probe.dispose()
      expect(child.kill).toHaveBeenCalled()
      child.emit('error', new Error('boom'))
      expect(unavailable).toEqual([])
    })

    it('fails without throwing when the spawn itself throws', () => {
      spawnMock.mockImplementation(() => {
        throw new Error('EPERM')
      })
      const probe = createP4IoProbe(4242, {
        onSample: (sample) => samples.push(sample),
        onUnavailable: (reason, kind) => unavailable.push({ reason, kind }),
      })
      expect(probe).toBeUndefined()
      expect(samples).toEqual([])
    })
  })

  describe('linux /proc polling', () => {
    const samples: { read: number; write: number }[] = []
    const unavailable: { reason: string; kind: string }[] = []

    const seedTree = (root: number, children: readonly number[]): void => {
      fsState.dirs.set(`/proc/${root}/task`, [String(root)])
      fsState.files.set(`/proc/${root}/task/${root}/children`, children.join(' '))
      for (const pid of [root, ...children]) {
        fsState.files.set(`/proc/${pid}/io`, `rchar: ${pid * 10}\nwchar: ${pid}\n`)
      }
    }

    const startLinux = (): P4IoProbe => {
      const probe = createP4IoProbe(100, {
        onSample: (sample) => samples.push(sample),
        onUnavailable: (reason, kind) => unavailable.push({ reason, kind }),
      })
      expect(probe).toBeDefined()
      return probe!
    }

    beforeEach(() => {
      setPlatform('linux')
      vi.useFakeTimers()
      samples.length = 0
      unavailable.length = 0
    })

    it('sums the tree, then reports only the growth', async () => {
      seedTree(100, [200])
      const probe = startLinux()
      await vi.advanceTimersByTimeAsync(1000)
      expect(samples).toEqual([{ read: 3000, write: 300 }])
      fsState.files.set('/proc/100/io', 'rchar: 1100\nwchar: 100\n')
      fsState.files.set('/proc/200/io', 'rchar: 2500\nwchar: 200\n')
      await vi.advanceTimersByTimeAsync(1000)
      // Only the read counters moved: +100 on the root, +500 on the child.
      expect(samples.at(-1)).toEqual({ read: 600, write: 0 })
      probe.dispose()
      await vi.advanceTimersByTimeAsync(5000)
      expect(samples).toHaveLength(2)
    })

    it('stops polling on dispose', async () => {
      seedTree(100, [])
      const probe = startLinux()
      await vi.advanceTimersByTimeAsync(1000)
      expect(samples).toHaveLength(1)
      probe.dispose()
      await vi.advanceTimersByTimeAsync(3000)
      expect(samples).toHaveLength(1)
    })

    it('emits nothing for a tick that was already in flight when it was disposed', async () => {
      // Each tick awaits one small read per pid, so a dispose (sync finished,
      // watchdog killed p4) can land between the read and the emit.
      seedTree(100, [200])
      const probe = startLinux()
      // Fired synchronously, so the tick is suspended in its first /proc read by
      // the time dispose lands.
      vi.advanceTimersByTime(1000)
      probe.dispose()
      await flushMicrotasks()
      expect(samples).toEqual([])
    })

    it('reads no signal rather than a broken one when the process is gone', async () => {
      seedTree(100, [])
      const probe = startLinux()
      await vi.advanceTimersByTimeAsync(1000)
      fsState.files.delete('/proc/100/io')
      await vi.advanceTimersByTimeAsync(1000)
      // Sampled before, so this is the sync ending, not a broken source.
      expect(unavailable).toEqual([])
      probe.dispose()
    })

    it('goes quiet without latching when /proc never yields a sample', async () => {
      // A sync that ended before the first tick looks exactly like an unreadable
      // /proc from here, and the ambiguous case must not latch the source off.
      const probe = startLinux()
      await vi.advanceTimersByTimeAsync(1000)
      expect(samples).toEqual([])
      expect(unavailable).toEqual([])
      await vi.advanceTimersByTimeAsync(5000)
      expect(samples).toEqual([])
      probe.dispose()
    })
  })

  describe('command override (the e2e seam)', () => {
    it('runs a script override through the current runtime with the pid', () => {
      const originalNodeOptions = process.env.NODE_OPTIONS
      process.env.NODE_OPTIONS = '--inspect'
      try {
        process.env.UNIVERSE_P4_IO_PROBE = '/tmp/fake-probe.mjs'
        const child = new FakeChildProcess()
        spawnMock.mockReturnValue(child)
        const samples: unknown[] = []
        createP4IoProbe(777, {
          onSample: (sample) => samples.push(sample),
          onUnavailable: () => {},
        })
        const [command, argv, spawnOptions] = spawnMock.mock.calls[0] as [
          string,
          string[],
          { env: Record<string, string | undefined> },
        ]
        expect([command, argv]).toEqual([process.execPath, ['/tmp/fake-probe.mjs', '777']])
        // The extension host is Electron-as-node, so the flag has to be re-added
        // or this "script" child starts a second editor window instead.
        expect(spawnOptions.env['ELECTRON_RUN_AS_NODE']).toBe('1')
        expect(spawnOptions.env['NODE_OPTIONS']).toBeUndefined()
        emitLines(child, 'S 512 8\n')
        expect(samples).toEqual([{ read: 512, write: 8 }])
      } finally {
        if (originalNodeOptions === undefined) delete process.env.NODE_OPTIONS
        else process.env.NODE_OPTIONS = originalNodeOptions
      }
    })

    it('spawns a non-script override directly, as a plain child', () => {
      process.env.UNIVERSE_P4_IO_PROBE = '/usr/local/bin/my-sampler'
      spawnMock.mockReturnValue(new FakeChildProcess())
      createP4IoProbe(777, { onSample: () => {}, onUnavailable: () => {} })
      const [command, argv, spawnOptions] = spawnMock.mock.calls[0] as [
        string,
        string[],
        { env: Record<string, string | undefined> },
      ]
      expect([command, argv]).toEqual(['/usr/local/bin/my-sampler', ['777']])
      expect(spawnOptions.env['ELECTRON_RUN_AS_NODE']).toBeUndefined()
    })
  })
})
