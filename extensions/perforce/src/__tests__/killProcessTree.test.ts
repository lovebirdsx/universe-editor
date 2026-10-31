import { beforeEach, describe, expect, it, vi } from 'vitest'

const { execFileMock, execState } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
  execState: { available: true },
}))

// getter 而不是值：既有的 28 个测试文件把 node:child_process 整体 mock 成
// 只导出 spawn，生产 helper 必须能从「没有 execFile」优雅回退。
vi.mock('node:child_process', () => ({
  get execFile() {
    return execState.available ? execFileMock : undefined
  },
}))

const { killProcessTree } = await import('../killProcessTree.js')

function fakeProcess(pid: number | undefined): {
  pid: number | undefined
  kill: ReturnType<typeof vi.fn>
} {
  return { pid, kill: vi.fn() }
}

function taskkillCallback(): (error: Error | null) => void {
  const call = execFileMock.mock.calls[0]
  if (call === undefined) throw new Error('taskkill was not invoked')
  return call[3] as (error: Error | null) => void
}

beforeEach(() => {
  execFileMock.mockClear()
  execState.available = true
})

describe('killProcessTree', () => {
  it('runs taskkill /pid <pid> /T /F on win32 and leaves killing the parent to it', () => {
    const target = fakeProcess(4321)

    killProcessTree(target, { platform: 'win32' })

    expect(execFileMock).toHaveBeenCalledTimes(1)
    expect(execFileMock).toHaveBeenCalledWith(
      'taskkill',
      ['/pid', '4321', '/T', '/F'],
      expect.objectContaining({ windowsHide: true, timeout: 5000 }),
      expect.any(Function),
    )
    expect(target.kill).not.toHaveBeenCalled()

    taskkillCallback()(null)
    expect(target.kill).not.toHaveBeenCalled()
  })

  it('falls back to proc.kill() and logs when taskkill reports an error', () => {
    const target = fakeProcess(4321)
    const log = vi.fn()

    killProcessTree(target, { platform: 'win32', log })
    taskkillCallback()(new Error('taskkill failed'))

    expect(target.kill).toHaveBeenCalledTimes(1)
    expect(log).toHaveBeenCalledWith(expect.stringContaining('taskkill 4321 failed'))
  })

  it('falls back when the module exposes no execFile (whole-module test mocks)', () => {
    execState.available = false
    const target = fakeProcess(4321)
    const log = vi.fn()

    killProcessTree(target, { platform: 'win32', log })

    expect(execFileMock).not.toHaveBeenCalled()
    expect(target.kill).toHaveBeenCalledTimes(1)
    expect(log).toHaveBeenCalledWith(expect.stringContaining('taskkill unavailable'))
  })

  it('swallows a throwing log callback on the fallback path', () => {
    const target = fakeProcess(4321)

    killProcessTree(target, {
      platform: 'win32',
      log: () => {
        throw new Error('log sink exploded')
      },
    })

    expect(() => taskkillCallback()(new Error('taskkill failed'))).not.toThrow()
    expect(target.kill).toHaveBeenCalledTimes(1)
  })

  it('falls back to proc.kill() when the child has no usable pid', () => {
    for (const pid of [undefined, 0, -1, 1.5]) {
      execFileMock.mockClear()
      const target = fakeProcess(pid)

      killProcessTree(target, { platform: 'win32' })

      expect(execFileMock).not.toHaveBeenCalled()
      expect(target.kill).toHaveBeenCalledTimes(1)
    }
  })

  it('uses proc.kill() off win32', () => {
    const target = fakeProcess(4321)

    killProcessTree(target, { platform: 'linux' })

    expect(execFileMock).not.toHaveBeenCalled()
    expect(target.kill).toHaveBeenCalledTimes(1)
  })

  it('falls back when the injected tree killer throws', () => {
    const target = fakeProcess(4321)

    killProcessTree(target, {
      platform: 'win32',
      killTree: () => {
        throw new Error('boom')
      },
    })

    expect(target.kill).toHaveBeenCalledTimes(1)
  })

  it('swallows a throwing proc.kill()', () => {
    const target = {
      pid: 4321,
      kill: vi.fn(() => {
        throw new Error('already gone')
      }),
    }

    expect(() =>
      killProcessTree(target, {
        platform: 'win32',
        killTree: (_pid, fallback) => fallback(),
      }),
    ).not.toThrow()
    expect(target.kill).toHaveBeenCalledTimes(1)
  })
})
